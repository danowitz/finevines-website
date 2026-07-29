package main

import (
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
