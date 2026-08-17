package reviewactions

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// FileStore is the local acceptance-test adapter for the same immutable object
// contract used by Bunny storage. The root confinement check makes it safe to
// expose through CLI flags without allowing review object names to escape.
type FileStore struct{ Root string }

func (store FileStore) name(relative string) (string, error) {
	root, err := filepath.Abs(store.Root)
	if err != nil {
		return "", err
	}
	name, err := filepath.Abs(filepath.Join(root, filepath.FromSlash(relative)))
	if err != nil {
		return "", err
	}
	if name != root && !strings.HasPrefix(name, root+string(filepath.Separator)) {
		return "", fmt.Errorf("review object escapes local store")
	}
	return name, nil
}

func (store FileStore) List(_ context.Context, prefix string) ([]string, error) {
	name, err := store.name(prefix)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(name)
	if os.IsNotExist(err) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	values := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			values = append(values, entry.Name())
		}
	}
	sort.Strings(values)
	return values, nil
}

func (store FileStore) Download(_ context.Context, relative string) ([]byte, error) {
	name, err := store.name(relative)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(name)
	if os.IsNotExist(err) {
		return nil, nil
	}
	return data, err
}

func (store FileStore) Upload(ctx context.Context, relative string, data []byte) error {
	name, err := store.name(relative)
	if err != nil {
		return err
	}
	if existing, readErr := store.Download(ctx, relative); readErr != nil {
		return readErr
	} else if len(existing) > 0 {
		if bytes.Equal(existing, data) {
			return nil
		}
		return fmt.Errorf("immutable review object already exists with different bytes")
	}
	if err := os.MkdirAll(filepath.Dir(name), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(name), ".review-object-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryName, name); err != nil {
		return err
	}
	return nil
}

func (store FileStore) Delete(_ context.Context, relative string) error {
	name, err := store.name(relative)
	if err != nil {
		return err
	}
	if err := os.Remove(name); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
