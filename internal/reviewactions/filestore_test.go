package reviewactions

import (
	"context"
	"testing"
)

func TestFileStorePreservesImmutableObjectsAndConfinesPaths(t *testing.T) {
	store := FileStore{Root: t.TempDir()}
	ctx := context.Background()
	if err := store.Upload(ctx, "_review/test/actions/one.json", []byte("one")); err != nil {
		t.Fatal(err)
	}
	if err := store.Upload(ctx, "_review/test/actions/one.json", []byte("one")); err != nil {
		t.Fatal(err)
	}
	if err := store.Upload(ctx, "_review/test/actions/one.json", []byte("different")); err == nil {
		t.Fatal("different immutable bytes were accepted")
	}
	if _, err := store.Download(ctx, "../../outside"); err == nil {
		t.Fatal("escaping path was accepted")
	}
	values, err := store.List(ctx, "_review/test/actions")
	if err != nil {
		t.Fatal(err)
	}
	if len(values) != 1 || values[0] != "one.json" {
		t.Fatalf("values = %#v", values)
	}
}
