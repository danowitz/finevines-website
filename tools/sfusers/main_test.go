package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"
)

func TestSummarizeNormalizesUserAndRelationships(t *testing.T) {
	rows := []map[string]any{{
		"Id": "005abc", "Name": "Barb Fultz", "Email": "barb@example.com",
		"IsActive": true, "UserType": "Standard", "Title": nil,
		"Profile":  map[string]any{"Name": "System Administrator"},
		"UserRole": map[string]any{"Name": "Back Office"},
		"Manager":  nil,
	}}

	users := summarize(rows)
	if len(users) != 1 {
		t.Fatalf("len(users) = %d, want 1", len(users))
	}
	got := users[0]
	if got.ID != "005abc" || got.Name != "Barb Fultz" || !got.Active {
		t.Fatalf("identity/status = %#v", got)
	}
	if got.Profile != "System Administrator" || got.Role != "Back Office" {
		t.Fatalf("relationships = profile %q role %q", got.Profile, got.Role)
	}
	if got.Title != "" || got.Manager != "" {
		t.Fatalf("null fields should normalize to empty strings: %#v", got)
	}
}

func TestUserSummaryJSONOmitsEmptyOptionalFields(t *testing.T) {
	data, err := json.Marshal(userSummary{ID: "005abc", Name: "Example", Active: true})
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	if strings.Contains(got, "title") || !strings.Contains(got, `"active":true`) {
		t.Fatalf("unexpected JSON: %s", got)
	}
}

func TestPrintUsersIncludesSummaryAndSelectionMetadata(t *testing.T) {
	got := captureStdout(t, func() {
		printUsers([]userSummary{{
			ID: "005abc", Name: "Barb Fultz", Email: "barb@example.com", Active: true,
			UserType: "Standard", Profile: "System Administrator", Role: "Back Office",
		}})
	})
	for _, want := range []string{
		"1 total, 1 active, 0 inactive", "[ACTIVE] Barb Fultz <barb@example.com>",
		"type=Standard", "profile=System Administrator", "role=Back Office",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("output missing %q:\n%s", want, got)
		}
	}
}

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	fn()
	_ = w.Close()
	os.Stdout = old
	var buf bytes.Buffer
	_, _ = io.Copy(&buf, r)
	_ = r.Close()
	return buf.String()
}
