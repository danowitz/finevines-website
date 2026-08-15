package model

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// LoadTeamMembers reads data/team.json. A missing file is an empty roster so
// the first live Salesforce sync can seed it.
func LoadTeamMembers(path string) ([]TeamMember, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return []TeamMember{}, nil
	}
	if err != nil {
		return nil, err
	}
	var team []TeamMember
	if err := json.Unmarshal(data, &team); err != nil {
		return nil, err
	}
	return team, nil
}

// SaveTeamMembers validates and atomically replaces data/team.json. Rejecting
// an empty roster protects the public page from a successful-but-wrong
// Salesforce query or permission change.
func SaveTeamMembers(path string, team []TeamMember) error {
	if err := ValidateTeamMembers(team); err != nil {
		return fmt.Errorf("refusing to replace %s: %w", path, err)
	}

	data, err := json.MarshalIndent(team, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

// ValidateTeamMembers checks a candidate before a long enrichment run starts,
// while SaveTeamMembers repeats the same check at the write boundary.
func ValidateTeamMembers(team []TeamMember) error {
	if len(team) == 0 {
		return fmt.Errorf("empty team roster")
	}
	seenEmails := make(map[string]struct{}, len(team))
	for i, member := range team {
		if strings.TrimSpace(member.Name) == "" || strings.TrimSpace(member.Role) == "" || strings.TrimSpace(member.Email) == "" {
			return fmt.Errorf("team member %d requires name, role, and email", i+1)
		}
		email := strings.ToLower(strings.TrimSpace(member.Email))
		if !strings.Contains(email, "@") {
			return fmt.Errorf("team member %q has invalid email %q", member.Name, member.Email)
		}
		if _, exists := seenEmails[email]; exists {
			return fmt.Errorf("team roster contains duplicate email %q", member.Email)
		}
		seenEmails[email] = struct{}{}
	}

	return nil
}
