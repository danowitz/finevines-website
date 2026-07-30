package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

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
