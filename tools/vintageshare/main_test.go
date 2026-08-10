package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/gritautomation/finevines-website/internal/model"
)

// TestCopyFileSameSrcDstLeavesContentIntact reproduces the incident:
// SKUs 711547/711545 share a slug, so vintageshare's donor ImagePath and
// its computed recipient dst named the same file on disk. copyFile used to
// os.Open(src) then os.Create(dst) then io.Copy — and os.Create truncates
// dst (== src) to zero bytes before a single byte is ever read. The two path
// strings here deliberately differ (forward-slash vs filepath.Join'd native
// separators) exactly like the real src/dst pairing, so this test would not
// have caught the bug if it only compared the raw strings.
func TestCopyFileSameSrcDstLeavesContentIntact(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "wine.jpg")
	want := []byte("not-actually-a-jpeg-but-definitely-nonzero-bytes")
	if err := os.WriteFile(path, want, 0o644); err != nil {
		t.Fatalf("test setup: %v", err)
	}

	src := filepath.ToSlash(path)         // mirrors ImagePath as stored in wines.json
	dst := filepath.Join(dir, "wine.jpg") // mirrors filepath.Join(...) in the caller
	if src == dst {
		t.Fatalf("test setup did not produce differing path strings on this OS: %q", src)
	}

	if err := copyFile(src, dst); err != nil {
		t.Fatalf("copyFile(self, self) returned an error: %v", err)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading file after self-copy: %v", err)
	}
	if len(got) == 0 {
		t.Fatalf("copyFile(self, self) truncated the file to 0 bytes")
	}
	if string(got) != string(want) {
		t.Fatalf("copyFile(self, self) changed the file content: got %q, want %q", got, want)
	}
}

// TestCopyFileGenuineCopyWorks makes sure the same-file guard doesn't break
// the ordinary donor -> recipient copy: dst must end up with src's bytes,
// and src must be untouched.
func TestCopyFileGenuineCopyWorks(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "donor.jpg")
	dst := filepath.Join(dir, "recipient.jpg")
	want := []byte("donor-bottle-photo-bytes")
	if err := os.WriteFile(src, want, 0o644); err != nil {
		t.Fatalf("test setup: %v", err)
	}

	if err := copyFile(src, dst); err != nil {
		t.Fatalf("copyFile: %v", err)
	}

	gotDst, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("reading dst: %v", err)
	}
	if string(gotDst) != string(want) {
		t.Fatalf("dst content = %q, want %q", gotDst, want)
	}
	gotSrc, err := os.ReadFile(src)
	if err != nil {
		t.Fatalf("reading src: %v", err)
	}
	if string(gotSrc) != string(want) {
		t.Fatalf("src was mutated by the copy: got %q, want %q", gotSrc, want)
	}
}

// TestPlanSharesGenuineCopyIsPlannedAndCounted covers the ordinary case: a
// placeholder recipient in the same identity group as a real-image donor,
// with a genuinely different destination path, is planned as a share.
func TestPlanSharesGenuineCopyIsPlannedAndCounted(t *testing.T) {
	wines := []model.Wine{
		{
			SKU: "D1", Producer: "Domaine Test", Name: "Cuvee Alpha", Vintage: "2020",
			Slug: "domaine-test-cuvee-alpha-2020", ImageSource: model.ImageScrapedWeb,
			ImagePath: "assets/img/wines/domaine-test-cuvee-alpha-2020.jpg",
		},
		{
			SKU: "R1", Producer: "Domaine Test", Name: "Cuvee Alpha", Vintage: "2019",
			Slug: "domaine-test-cuvee-alpha-2019", ImageSource: model.ImageGeneratedLabel,
		},
	}

	toShare, skipped, groupsHelped := planShares(wines)

	if len(skipped) != 0 {
		t.Fatalf("expected no skips, got %d: %+v", len(skipped), skipped)
	}
	if len(toShare) != 1 {
		t.Fatalf("expected 1 planned share, got %d: %+v", len(toShare), toShare)
	}
	if toShare[0].recipient != 1 || toShare[0].donor != 0 {
		t.Fatalf("wrong recipient/donor indices: %+v", toShare[0])
	}
	if groupsHelped != 1 {
		t.Fatalf("groupsHelped = %d, want 1", groupsHelped)
	}
}

// TestPlanSharesSkipsDuplicateSlugCollisionAndExcludesItFromCount reproduces
// tonight's incident at the planning level: two SKUs collapse to the same
// slug, so the recipient's computed dst is literally the donor's own
// ImagePath. That pair must be skipped (no share planned) and must not
// count toward groupsHelped.
func TestPlanSharesSkipsDuplicateSlugCollisionAndExcludesItFromCount(t *testing.T) {
	wines := []model.Wine{
		{
			SKU: "711547", Producer: "Virgile Lignier-Michelot", Name: "Clos de la Roche Grand Cru", Vintage: "2018",
			Slug:        "virgile-lignier-michelot-clos-de-la-roche-grand-cru-2018",
			ImageSource: model.ImageScrapedWeb,
			ImagePath:   "assets/img/wines/virgile-lignier-michelot-clos-de-la-roche-grand-cru-2018.jpg",
		},
		{
			SKU: "711545", Producer: "Virgile Lignier-Michelot", Name: "Clos de la Roche Grand Cru", Vintage: "2018",
			Slug:        "virgile-lignier-michelot-clos-de-la-roche-grand-cru-2018",
			ImageSource: model.ImageGeneratedLabel,
		},
	}

	toShare, skipped, groupsHelped := planShares(wines)

	if len(toShare) != 0 {
		t.Fatalf("expected the slug collision to be skipped, not planned: %+v", toShare)
	}
	if len(skipped) != 1 {
		t.Fatalf("expected 1 skip, got %d: %+v", len(skipped), skipped)
	}
	if skipped[0].recipient != 1 || skipped[0].donor != 0 {
		t.Fatalf("wrong recipient/donor indices on skip: %+v", skipped[0])
	}
	if groupsHelped != 0 {
		t.Fatalf("groupsHelped = %d, want 0 (a skip-only group must not count as helped)", groupsHelped)
	}
}

// TestPlanSharesMixedGroupCountsOnlyGenuineShare covers a group with both a
// genuine share and a colliding skip, making sure the skip doesn't leak into
// the share count or suppress the genuine one.
func TestPlanSharesMixedGroupCountsOnlyGenuineShare(t *testing.T) {
	wines := []model.Wine{
		{
			SKU: "D1", Producer: "Mixed House", Name: "Reserve", Vintage: "2021",
			Slug: "mixed-house-reserve-2021", ImageSource: model.ImageScrapedWeb,
			ImagePath: "assets/img/wines/mixed-house-reserve-2021.jpg",
		},
		{ // genuine recipient: distinct slug, a real upgrade opportunity
			SKU: "R1", Producer: "Mixed House", Name: "Reserve", Vintage: "2020",
			Slug: "mixed-house-reserve-2020", ImageSource: model.ImageGeneratedLabel,
		},
		{ // colliding recipient: slug matches the donor's own image path
			SKU: "R2", Producer: "Mixed House", Name: "Reserve", Vintage: "2021",
			Slug: "mixed-house-reserve-2021", ImageSource: model.ImageGeneratedLabel,
		},
	}

	toShare, skipped, groupsHelped := planShares(wines)

	if len(toShare) != 1 || toShare[0].recipient != 1 {
		t.Fatalf("expected exactly the genuine recipient planned, got %+v", toShare)
	}
	if len(skipped) != 1 || skipped[0].recipient != 2 {
		t.Fatalf("expected exactly the colliding recipient skipped, got %+v", skipped)
	}
	if groupsHelped != 1 {
		t.Fatalf("groupsHelped = %d, want 1 (the genuine share still counts the group as helped)", groupsHelped)
	}
}
