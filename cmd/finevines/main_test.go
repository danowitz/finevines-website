package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gritautomation/finevines-website/internal/config"
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

func TestValidateClientContentForDeploy(t *testing.T) {
	confirmed := model.SiteContent{ContactConfirmed: true}
	pending := model.SiteContent{}

	for _, baseURL := range []string{"https://finevines.biz", "https://www.finevines.biz/"} {
		if err := validateClientContentForDeploy(baseURL, confirmed); err != nil {
			t.Errorf("confirmed production content rejected for %s: %v", baseURL, err)
		}
		err := validateClientContentForDeploy(baseURL, pending)
		if err == nil {
			t.Errorf("unconfirmed production content accepted for %s", baseURL)
		} else {
			for _, want := range []string{"contact details", "contactConfirmed", "data/site.json"} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("production gate error missing %q: %v", want, err)
				}
			}
		}
	}

	if err := validateClientContentForDeploy("https://staging.finevines.example", pending); err != nil {
		t.Errorf("staging deploy should allow unconfirmed candidate content: %v", err)
	}
	if err := validateClientContentForDeploy("finevines.biz", confirmed); err == nil {
		t.Error("relative site base URL should be rejected")
	}
}

func TestMergeSalesforceTeamUsesRoleAndPreservesLocalPhotoMetadata(t *testing.T) {
	users := []salesforce.TeamUser{
		{ID: "1", Name: "George Molitor", Email: "george@finevines.com", Role: "Executive"},
		{ID: "2", Name: "Daniel Pilkey", Email: "dan@finevines.com", Role: "Sales Rep"},
	}
	existing := []model.TeamMember{
		{Name: "George Molitor", Email: "george@finevines.com", Role: "Founder & President", PhotoPath: "assets/img/team/george.jpg"},
		{Name: "Dan Pilkey", Email: "dan@finevines.com", Role: "Sales", Note: "portrait requested"},
	}

	got := mergeSalesforceTeam(users, existing)
	if len(got) != 2 {
		t.Fatalf("len(team) = %d, want 2", len(got))
	}
	if got[0].Role != "Executive" || got[0].PhotoPath != "assets/img/team/george.jpg" {
		t.Fatalf("George = %#v", got[0])
	}
	if got[1].Name != "Daniel Pilkey" || got[1].Role != "Sales Rep" || got[1].Note != "portrait requested" {
		t.Fatalf("Daniel = %#v", got[1])
	}
}

// findImgnorm must hand back a path os/exec can actually run. A bare
// "imgnorm"/"imgnorm.exe" cannot be: exec resolves a name with no path
// separator against $PATH only, never the working directory, and
// filepath.Join(".", name) cleans the "./" right back off. The result was a
// binary that Stat found and exec could not launch, which made every
// console image-swap fail — on Linux CI exactly as on a Windows workstation.
func TestFindImgnorm_ReturnsAnExecutablePathNotABareName(t *testing.T) {
	t.Chdir(t.TempDir())
	if err := os.WriteFile(imgnormCandidates[0], []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := findImgnorm()
	if err != nil {
		t.Fatalf("findImgnorm returned error: %v", err)
	}
	if !filepath.IsAbs(got) {
		t.Errorf("findImgnorm = %q, want an absolute path — a relative one is resolved against $PATH, not the cwd", got)
	}
	if _, err := os.Stat(got); err != nil {
		t.Errorf("findImgnorm returned %q, which does not exist: %v", got, err)
	}
}

// A missing binary must be a loud error, not a silent skip: an image-swap that
// quietly did nothing leaves a reviewer believing they fixed the wrong bottle.
func TestFindImgnorm_MissingBinaryIsAnError(t *testing.T) {
	t.Chdir(t.TempDir())
	if _, err := findImgnorm(); err == nil {
		t.Fatal("findImgnorm accepted a directory with no imgnorm binary, want an error")
	}
}

// A digest is a DIFF, and model.LoadWines reads a missing file as an empty
// catalog — so a mistyped or never-created -before path does not fail, it
// diffs the whole portfolio against nothing and mails the client five thousand
// wines as "new". The one place that is most likely to happen is the one place
// it does most damage: a hand-run recovery digest, typed at 2am against a path
// that does not exist. So the path is checked before anything is loaded.
func TestRunNotify_MissingBeforeSnapshotIsRefusedBeforeAnythingIsLoaded(t *testing.T) {
	// An empty working directory: without the check, LoadWines would read BOTH
	// snapshots as empty, Diff would report no changes, and the run would exit 0
	// having quietly done nothing — the same silent failure in a different shape.
	t.Chdir(t.TempDir())

	// Credentials are deliberately present. If the guard were missing or ran too
	// late, this test would reach the SMTP sender, and "no send attempted" is
	// exactly what it is asserting.
	cfg := config.Config{
		SMTPHost: "send.example.com", SMTPPort: 587, SMTPUser: "u", SMTPPass: "p",
		NotifyFrom: "a@example.com", NotifyTo: "b@example.com",
	}
	err := runNotify(cfg, []string{"-before", "no/such/wines-before.json"})
	if err == nil {
		t.Fatal("runNotify accepted a missing -before snapshot; it would diff the whole catalog against nothing")
	}
	for _, want := range []string{"before-snapshot not found", "no/such/wines-before.json", "empty baseline"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
}

// A run that DID change something must not try to send with half a relay
// configuration: the failure has to name the missing secret, because the only
// person who will read it is looking at a 2:15am workflow log.
func TestRunNotify_EverySMTPSecretIsRequiredBeforeSending(t *testing.T) {
	full := config.Config{
		SMTPHost: "send.example.com", SMTPPort: 587, SMTPUser: "u", SMTPPass: "p",
		NotifyFrom: "catalog@finevines.biz", NotifyTo: "george@example.com",
	}
	for _, tc := range []struct {
		name string
		drop func(*config.Config)
		want string
	}{
		{"host", func(c *config.Config) { c.SMTPHost = "" }, "FINEVINES_SMTP_HOST"},
		{"port", func(c *config.Config) { c.SMTPPort = 0 }, "FINEVINES_SMTP_PORT"},
		{"user", func(c *config.Config) { c.SMTPUser = "" }, "FINEVINES_SMTP_USER"},
		{"password", func(c *config.Config) { c.SMTPPass = "" }, "FINEVINES_SMTP_PASS"},
		{"from", func(c *config.Config) { c.NotifyFrom = "" }, "FINEVINES_NOTIFY_FROM"},
		{"to", func(c *config.Config) { c.NotifyTo = "" }, "FINEVINES_NOTIFY_TO"},
	} {
		t.Run("missing "+tc.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Chdir(dir)
			// A real change, so the run gets past the no-changes short-circuit and
			// reaches the credential check.
			writeWines(t, filepath.Join(dir, "wines-before.json"), `[]`)
			writeWines(t, filepath.Join(dir, "data", "wines.json"),
				`[{"sku":"1001","slug":"a-wine","producer":"Domaine A","name":"A Wine","stockQty":5}]`)

			cfg := full
			tc.drop(&cfg)
			err := runNotify(cfg, []string{"-before", "wines-before.json"})
			if err == nil {
				t.Fatalf("runNotify sent the digest with %s unset", tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error %q does not name the missing %s", err, tc.want)
			}
		})
	}
}

func writeWines(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadActionIDsRejectsUnsafeClaims(t *testing.T) {
	path := filepath.Join(t.TempDir(), "claims.json")
	if err := os.WriteFile(path, []byte(`["00000000-0000-4000-8000-000000000001"]`), 0o644); err != nil {
		t.Fatal(err)
	}
	ids, err := loadActionIDs(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := ids["00000000-0000-4000-8000-000000000001"]; !ok || len(ids) != 1 {
		t.Fatalf("claims = %#v", ids)
	}
	if err := os.WriteFile(path, []byte(`["../../pending"]`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadActionIDs(path); err == nil {
		t.Fatal("unsafe action id was accepted")
	}
}
