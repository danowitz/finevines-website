package queue

import (
	"context"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"time"

	"github.com/gritautomation/finevines-website/internal/enrich"
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

// Store is the subset of the Bunny storage zone a drain needs: read a file,
// delete a file. Declared here rather than depending on *deploy.BunnyClient so
// tests inject an in-memory fake with no network and no credentials — the same
// reasoning as internal/deploy.Uploader. *deploy.BunnyClient satisfies it
// unchanged (asserted in cmd/finevines/applyqueue.go).
type Store interface {
	Download(ctx context.Context, relPath string) ([]byte, error)
	Delete(ctx context.Context, relPath string) error
}

// TextEnricher regenerates a wine's catalog prose with a reviewer's note
// appended to the prompt. *enrich.OpenAIEnricher satisfies it.
type TextEnricher interface {
	EnrichWithNote(ctx context.Context, w salesforce.WineRaw, note string) (enrich.EnrichResult, error)
}

// Normalizer re-composes a candidate image onto the catalog's fixed 600x900
// canvas — the same tools/imgnorm step tools/labelfetch/import.mjs runs, so a
// console swap and a nightly import produce identical geometry and the
// portfolio grid does not start jostling wherever a human intervened.
type Normalizer interface {
	Normalize(ctx context.Context, srcPath, dstPath string) error
}

// Input is everything one drain needs. A struct rather than an argument list
// because that list is eleven values long, and both callers — main.go and the
// tests — would otherwise have to keep them in the same order by hand.
type Input struct {
	Store   Store
	Texts   TextEnricher
	Norm    Normalizer
	Actions []Action
	Wines   []model.Wine
	Ledger  Ledger
	Flags   []Flag
	// ImgDir is the on-disk catalog image directory (assets/img/wines).
	ImgDir string
	// CandidateDir is the storage-zone prefix the console stages candidate
	// images under (_review/candidates). Payload.Candidate is relative to it.
	CandidateDir string
	// QueuePath is the storage-zone path of the queue file itself, deleted once
	// the drain has finished (_review/queue.json).
	QueuePath string
	Now       time.Time
	Log       func(string, ...any)
}

// Result is what one drain changed. Wines and Ledger are the new values to
// persist; Applied is only THIS run's entries, which is what the digest email
// reports (the ledger holds every entry ever).
type Result struct {
	Wines   []model.Wine
	Ledger  Ledger
	Flags   []Flag
	Applied []Applied
	Skipped int
}

// Apply drains in.Actions against in.Wines.
//
// Order and failure handling, both load-bearing:
//
//   - Actions already in the ledger are skipped without calling anything. That
//     is the idempotency guarantee: a run that crashes halfway through a drain,
//     or a second repository_dispatch fired for the same batch, re-reads the
//     same queue and applies nothing twice.
//   - A per-action failure is logged and that action is left OUT of the ledger,
//     so the next run retries it. It does not abort the drain: one unreachable
//     candidate image must not strand the other four reviewers' fixes.
//   - An action naming a SKU the catalog does not hold IS ledgered, with the
//     reason. Leaving it unrecorded would have every future run retry it
//     forever and the queue would never drain.
//   - The queue file is deleted last, and only if there was anything in it.
//     Deleting rather than truncating is safe even though the console may append
//     mid-drain: the console rewrites the whole file, so an action that
//     reappears is simply re-read next run and skipped by the ledger.
func Apply(ctx context.Context, in Input) (Result, error) {
	log := in.Log
	if log == nil {
		log = func(string, ...any) {}
	}

	res := Result{Wines: append([]model.Wine(nil), in.Wines...), Ledger: in.Ledger, Flags: in.Flags}
	if len(in.Actions) == 0 {
		return res, nil
	}

	bySKU := make(map[string]int, len(res.Wines))
	for i, w := range res.Wines {
		bySKU[w.SKU] = i
	}
	stamp := in.Now.UTC().Format(time.RFC3339)

	record := func(a Action, outcome string) {
		entry := Applied{ID: a.ID, SKU: a.SKU, Kind: a.Kind, Reviewer: a.Reviewer,
			AppliedAt: stamp, Outcome: outcome}
		res.Ledger.Applied = append(res.Ledger.Applied, entry)
		res.Applied = append(res.Applied, entry)
	}

	for _, a := range in.Actions {
		if res.Ledger.Has(a.ID) {
			res.Skipped++
			continue
		}
		i, ok := bySKU[a.SKU]
		if !ok {
			log("applyqueue: action %s (%s) names SKU %s, which is not in the catalog — recording and moving on",
				a.ID, a.Kind, a.SKU)
			record(a, "no such SKU in the catalog")
			continue
		}

		outcome, err := applyOne(ctx, in, &res, i, a)
		if err != nil {
			// Not ledgered: the next run retries it.
			log("applyqueue: action %s (%s, SKU %s) failed, will retry next run: %v",
				a.ID, a.Kind, a.SKU, err)
			continue
		}
		log("applyqueue: %s on %s by %s — %s", a.Kind, a.SKU, a.Reviewer, outcome)
		record(a, outcome)
	}

	if err := in.Store.Delete(ctx, in.QueuePath); err != nil {
		return res, fmt.Errorf("applyqueue: clear %s (actions already applied — the ledger stops them re-applying): %w",
			in.QueuePath, err)
	}
	return res, nil
}

// applyOne applies a single action to res.Wines[i] and returns the ledger
// outcome prose. An unknown Kind is an error, not a silent skip: a console
// shipping an action type this binary predates must be visible.
func applyOne(ctx context.Context, in Input, res *Result, i int, a Action) (string, error) {
	switch a.Kind {
	case ActionImageSwap:
		return swapImage(ctx, in, &res.Wines[i], a)
	case ActionTextFeedback:
		return regenerateText(ctx, in, &res.Wines[i], a)
	case ActionFlag:
		res.Flags = append(res.Flags, Flag{
			SKU: a.SKU, Slug: res.Wines[i].Slug, Reviewer: a.Reviewer,
			Reason: a.Payload.Reason, FlaggedAt: in.Now.UTC().Format(time.RFC3339),
		})
		return "flagged for human attention: " + a.Payload.Reason, nil
	default:
		return "", fmt.Errorf("unknown action kind %q", a.Kind)
	}
}

// swapImage replaces the wine's photograph with the candidate the reviewer
// picked, or drops back to the SVG label when they rejected all of them.
//
// The candidate goes through the normalizer rather than straight to disk: the
// catalog's images are all 600x900 with the bottle at a fixed height, and a raw
// fetched candidate is anywhere between 500x650 and 1200x1200. Consistency is
// the point of that step, and a console swap must not be the one place it is
// skipped.
func swapImage(ctx context.Context, in Input, w *model.Wine, a Action) (string, error) {
	if a.Payload.Candidate == CandidateNone {
		rel, err := writeSibling(in.ImgDir, w.Slug, "svg", "jpg", nil)
		if err != nil {
			return "", err
		}
		w.ImagePath, w.ImageSource, w.ImageSourceURL = rel, model.ImageGeneratedLabel, ""
		rescoreImage(w)
		// No bytes are written for a label: build.ensureLabels regenerates the
		// SVG deterministically from the wine's own fields, and the generated
		// labels are gitignored build artifacts precisely so nothing has to
		// carry them around.
		return "reverted to the generated label", nil
	}

	storagePath := path.Join(in.CandidateDir, a.Payload.Candidate)
	data, err := in.Store.Download(ctx, storagePath)
	if err != nil {
		return "", fmt.Errorf("fetch candidate %s: %w", storagePath, err)
	}
	if len(data) == 0 {
		return "", fmt.Errorf("candidate %s is empty or absent in the storage zone", storagePath)
	}

	staged := filepath.Join(os.TempDir(), "finevines-swap-"+w.Slug+filepath.Ext(a.Payload.Candidate))
	if err := os.WriteFile(staged, data, 0o644); err != nil {
		return "", fmt.Errorf("stage candidate: %w", err)
	}
	defer os.Remove(staged)

	dst := filepath.Join(in.ImgDir, w.Slug+".jpg")
	if err := os.MkdirAll(in.ImgDir, 0o755); err != nil {
		return "", err
	}
	if err := in.Norm.Normalize(ctx, staged, dst); err != nil {
		return "", fmt.Errorf("normalise candidate: %w", err)
	}
	// Remove the stale .svg placeholder, exactly as enrich.writeImageFile and
	// import.mjs both do — otherwise it ships as an orphan asset beside the jpg.
	if err := os.Remove(filepath.Join(in.ImgDir, w.Slug+".svg")); err != nil && !os.IsNotExist(err) {
		return "", err
	}

	w.ImagePath = path.Join(filepath.ToSlash(in.ImgDir), w.Slug+".jpg")
	w.ImageSource = model.ImageScrapedWeb
	// Provenance survives a console swap: the payload carries where the
	// candidate came from precisely so this stays answerable from the catalog.
	w.ImageSourceURL = a.Payload.SourceURL
	rescoreImage(w)
	return "image replaced with " + a.Payload.Candidate, nil
}

// regenerateText re-runs the wine's text generation with the reviewer's note
// appended, and writes back ONLY the prose. Everything else is deliberately
// untouched: the image (a text fix must never trade away a real photograph),
// the Salesforce-authoritative identity fields, and above all SourceHash —
// which is what stops the next enrich run paying OpenAI for this wine again.
func regenerateText(ctx context.Context, in Input, w *model.Wine, a Action) (string, error) {
	out, err := in.Texts.EnrichWithNote(ctx, enrich.RawFromWine(*w), a.Payload.Note)
	if err != nil {
		return "", fmt.Errorf("regenerate text: %w", err)
	}
	w.Description = out.Description
	w.SommelierNotes = out.SommelierNotes
	w.Aroma, w.Palate, w.Finish = out.Aroma, out.Palate, out.Finish
	w.FoodPairings = out.FoodPairings
	w.EnrichedAt = in.Now.UTC().Format(time.RFC3339)

	if w.Sources == nil {
		w.Sources = map[string]model.FieldSource{}
	}
	for field, src := range out.Sources {
		switch field {
		case "description", "sommelierNotes", "aroma", "palate", "finish", "foodPairings":
			w.Sources[field] = model.ParseFieldSource(src)
		}
	}
	w.MetadataScore = model.MetadataScore(w.Sources)
	return "text regenerated with the reviewer's note", nil
}

// rescoreImage re-derives the image field's provenance and the wine's coverage
// score after the image changed. Kept in one place so a swap can never leave
// Sources["image"] disagreeing with ImageSource — which would score the wine
// wrong AND, if it read as derived, have the next enrich run regenerate over it.
func rescoreImage(w *model.Wine) {
	if w.Sources == nil {
		w.Sources = map[string]model.FieldSource{}
	}
	w.Sources["image"] = model.ImageFieldSource(w.ImageSource)
	w.MetadataScore = model.MetadataScore(w.Sources)
}

// writeSibling computes the site-relative image path for <slug>.<ext> and
// removes the <slug>.<siblingExt> companion, writing data first when there is
// any. It mirrors enrich.writeImageFile, which is unexported.
func writeSibling(imgDir, slug, ext, siblingExt string, data []byte) (string, error) {
	if err := os.MkdirAll(imgDir, 0o755); err != nil {
		return "", err
	}
	if data != nil {
		if err := os.WriteFile(filepath.Join(imgDir, slug+"."+ext), data, 0o644); err != nil {
			return "", err
		}
	}
	if err := os.Remove(filepath.Join(imgDir, slug+"."+siblingExt)); err != nil && !os.IsNotExist(err) {
		return "", err
	}
	return path.Join(filepath.ToSlash(imgDir), slug+"."+ext), nil
}
