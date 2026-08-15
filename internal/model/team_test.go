package model

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestSaveAndLoadTeamMembers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "team.json")
	want := []TeamMember{{Name: "Connie Molitor", Role: "Executive", Email: "connie@finevines.com"}}
	if err := SaveTeamMembers(path, want); err != nil {
		t.Fatal(err)
	}
	got, err := LoadTeamMembers(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("LoadTeamMembers() = %#v, want %#v", got, want)
	}
}

func TestSaveTeamMembersRejectsUnsafeRoster(t *testing.T) {
	for _, tc := range []struct {
		name string
		team []TeamMember
		want string
	}{
		{"empty", nil, "empty team roster"},
		{"missing field", []TeamMember{{Name: "Barb", Role: "Back Office"}}, "requires name, role, and email"},
		{"bad email", []TeamMember{{Name: "Barb", Role: "Back Office", Email: "barb"}}, "invalid email"},
		{"duplicate email", []TeamMember{
			{Name: "Barb", Role: "Back Office", Email: "barb@finevines.com"},
			{Name: "Barbara", Role: "Back Office", Email: "BARB@finevines.com"},
		}, "duplicate email"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := SaveTeamMembers(filepath.Join(t.TempDir(), "team.json"), tc.team)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want containing %q", err, tc.want)
			}
		})
	}
}
