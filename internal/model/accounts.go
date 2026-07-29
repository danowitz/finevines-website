package model

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// AccountsServed is data/accounts.json: how many distinct accounts had at
// least one invoice in the trailing window, written by `finevines enrich`
// from the org's invoice ledger (salesforce.AccountsServed) and read by
// `finevines build` for the homepage credibility ledger. Like
// hot-sellers.json the file is OPTIONAL — missing simply means the ledger
// omits its accounts-served entry (mock/dev runs, or orgs without the
// invoice sync). The exact count stays in this private repo file; the build
// renders a floored "400+" figure, never the precise number.
type AccountsServed struct {
	Updated    string `json:"updated"` // RFC3339, when the count was computed
	WindowDays int    `json:"windowDays"`
	Accounts   int    `json:"accounts"` // distinct accounts invoiced in the window
}

// LoadAccountsServed reads path; a missing file returns the zero value and no
// error (the ledger entry is optional by design — see AccountsServed).
func LoadAccountsServed(path string) (AccountsServed, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return AccountsServed{}, nil
	}
	if err != nil {
		return AccountsServed{}, err
	}
	var as AccountsServed
	if err := json.Unmarshal(data, &as); err != nil {
		return AccountsServed{}, err
	}
	return as, nil
}

// SaveAccountsServed writes path atomically (temp file + rename, same
// reader-must-see-a-complete-file rationale as SaveHotSellers).
func SaveAccountsServed(path string, as AccountsServed) error {
	data, err := json.MarshalIndent(as, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // no-op once the rename below has succeeded

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
