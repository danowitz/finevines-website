package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gritautomation/finevines-website/internal/config"
	"github.com/gritautomation/finevines-website/internal/model"
)

func TestValidateClientContentForDeploy(t *testing.T) {
	confirmed := model.SiteContent{ContactConfirmed: true, TeamEmailsConfirmed: true}
	pending := model.SiteContent{}

	for _, baseURL := range []string{"https://finevines.com", "https://www.finevines.com/"} {
		if err := validateClientContentForDeploy(baseURL, confirmed); err != nil {
			t.Errorf("confirmed production content rejected for %s: %v", baseURL, err)
		}
		err := validateClientContentForDeploy(baseURL, pending)
		if err == nil {
			t.Errorf("unconfirmed production content accepted for %s", baseURL)
		} else {
			for _, want := range []string{"contact details", "team email addresses", "data/site.json"} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("production gate error missing %q: %v", want, err)
				}
			}
		}
	}

	if err := validateClientContentForDeploy("https://staging.finevines.example", pending); err != nil {
		t.Errorf("staging deploy should allow unconfirmed candidate content: %v", err)
	}
	if err := validateClientContentForDeploy("finevines.com", confirmed); err == nil {
		t.Error("relative site base URL should be rejected")
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
	// late, this test would reach the Postmark sender, and "no send attempted" is
	// exactly what it is asserting.
	cfg := config.Config{PostmarkToken: "tok", NotifyFrom: "a@example.com", NotifyTo: "b@example.com"}
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
