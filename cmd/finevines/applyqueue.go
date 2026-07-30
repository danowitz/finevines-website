package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/gritautomation/finevines-website/internal/config"
	"github.com/gritautomation/finevines-website/internal/deploy"
	"github.com/gritautomation/finevines-website/internal/enrich"
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/queue"
)

// The one BunnyClient serves both roles: it uploads dist/ for deploy and reads
// _review/ for the drain. Asserted here rather than in internal/queue so that
// package stays free of any dependency on deploy.
var _ queue.Store = (*deploy.BunnyClient)(nil)

// Storage-zone layout for the review console's data (design spec §B "Data").
// _review/ is a path the public pull zone does not serve, so nothing here is
// reachable from finevines.com.
const (
	queueStoragePath = "_review/queue.json"
	candidateDir     = "_review/candidates"
)

// Repo paths the drain reads and writes. The ledger and the flag record are
// COMMITTED with the data — CI keeps no state between runs, and remembering
// across them is the entire point of the ledger.
const (
	queueLedgerPath = "data/queue-ledger.json"
	flagsPath       = "data/flags.json"
)

// imgnormBin is the normaliser tools/labelfetch/import.mjs also shells out to.
// Built into the repo root by the workflow; the extension-less name works on
// Linux and the .exe name is what a Windows workstation has, so both are tried.
var imgnormCandidates = []string{"imgnorm", "imgnorm.exe"}

// execNormalizer shells out to tools/imgnorm, the same way import.mjs does.
// Behind queue.Normalizer so the drain's tests never need the binary built.
type execNormalizer struct{ bin string }

func (n execNormalizer) Normalize(ctx context.Context, src, dst string) error {
	out, err := exec.CommandContext(ctx, n.bin, "-in", src, "-out", dst).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %v: %s", n.bin, err, out)
	}
	return nil
}

// findImgnorm locates the normaliser next to the working directory. A missing
// binary is an error at drain time rather than a silent skip: an image-swap
// that quietly did nothing would leave a reviewer looking at the wrong bottle
// and believing they had fixed it.
func findImgnorm() (string, error) {
	for _, c := range imgnormCandidates {
		if _, err := os.Stat(c); err == nil {
			// Absolutised deliberately. os/exec resolves a command name with no
			// path separator against $PATH ONLY, never the working directory —
			// and filepath.Join(".", "imgnorm") cleans straight back down to
			// "imgnorm", separator and all. Returning the relative form would
			// therefore fail to exec the very binary this Stat just found, on
			// Linux CI exactly as on Windows.
			abs, err := filepath.Abs(c)
			if err != nil {
				return "", fmt.Errorf("applyqueue: resolving %s: %w", c, err)
			}
			return abs, nil
		}
	}
	return "", fmt.Errorf("applyqueue: no imgnorm binary in the working directory — build it first:\n  go build -o imgnorm ./tools/imgnorm")
}

// runApplyQueue drains the review console's change queue. See internal/queue's
// package doc for the shape of the contract, and queue.Apply's for the
// idempotency and failure ordering.
//
// It writes THIS RUN's applied actions to a run-log file (default
// .run/queue-applied.json, gitignored) which `notify` reads later in the same
// workflow run to list the reviewer fixes in the digest. That is separate from
// data/queue-ledger.json, which is committed and holds every action ever
// applied.
func runApplyQueue(cfg config.Config, args []string) error {
	fs := flag.NewFlagSet("applyqueue", flag.ContinueOnError)
	runLog := fs.String("runlog", ".run/queue-applied.json",
		"where to write this run's applied actions for the digest email")
	if err := fs.Parse(args); err != nil {
		return err
	}

	requiredEnv := []struct{ name, value string }{
		{"FINEVINES_BUNNY_STORAGE_ZONE", cfg.BunnyStorageZone},
		{"FINEVINES_BUNNY_STORAGE_KEY", cfg.BunnyStorageKey},
		{"OPENAI_API_KEY", cfg.OpenAIAPIKey},
	}
	for _, req := range requiredEnv {
		if req.value == "" {
			return fmt.Errorf("applyqueue: set %s in .env (or the environment) before running applyqueue", req.name)
		}
	}

	client := deploy.NewBunnyClient(
		cfg.BunnyStorageEndpoint, cfg.BunnyStorageZone, cfg.BunnyStorageKey,
		cfg.BunnyAPIKey, cfg.BunnyPullZoneID, http.DefaultClient)

	raw, err := client.Download(context.Background(), queueStoragePath)
	if err != nil {
		return fmt.Errorf("applyqueue: fetch %s: %w", queueStoragePath, err)
	}
	actions, err := queue.ParseQueue(raw)
	if err != nil {
		return err
	}
	if len(actions) == 0 {
		log.Printf("applyqueue: %s is empty — nothing to drain", queueStoragePath)
		return writeRunLog(*runLog, nil)
	}
	log.Printf("applyqueue: %d queued action(s)", len(actions))

	wines, err := model.LoadWines("data/wines.json")
	if err != nil {
		return fmt.Errorf("applyqueue: load data/wines.json: %w", err)
	}
	ledger, err := queue.LoadLedger(queueLedgerPath)
	if err != nil {
		return fmt.Errorf("applyqueue: load %s: %w", queueLedgerPath, err)
	}
	flags, err := queue.LoadFlags(flagsPath)
	if err != nil {
		return fmt.Errorf("applyqueue: load %s: %w", flagsPath, err)
	}
	norm, err := findImgnorm()
	if err != nil {
		return err
	}

	res, err := queue.Apply(context.Background(), queue.Input{
		Store:        client,
		Texts:        enrich.NewOpenAIEnricher(cfg.OpenAIAPIKey, cfg.OpenAIModel, "", http.DefaultClient),
		Norm:         execNormalizer{bin: norm},
		Actions:      actions,
		Wines:        wines,
		Ledger:       ledger,
		Flags:        flags,
		ImgDir:       "assets/img/wines",
		CandidateDir: candidateDir,
		QueuePath:    queueStoragePath,
		// GITHUB_RUN_ID names the batch archive after the run that read it, so an
		// operator looking at a failed workflow run can find that run's archive by
		// the number already in front of them. Empty off CI, where the drain's own
		// clock names it instead.
		RunID: os.Getenv("GITHUB_RUN_ID"),
		Now:   time.Now().UTC(),
		Log:   log.Printf,
	})
	if err != nil {
		return err
	}

	// Persist in dependency order: the catalog, then the ledger, then the flags,
	// then the run log. The ledger after the catalog is the safe direction — a
	// crash between them re-applies an action that already landed, which is
	// harmless, whereas the reverse would record work that was never done.
	if err := model.SaveWines("data/wines.json", res.Wines); err != nil {
		return fmt.Errorf("applyqueue: save data/wines.json: %w", err)
	}
	if err := queue.SaveLedger(queueLedgerPath, res.Ledger); err != nil {
		return fmt.Errorf("applyqueue: save %s: %w", queueLedgerPath, err)
	}
	if err := queue.SaveFlags(flagsPath, res.Flags); err != nil {
		return fmt.Errorf("applyqueue: save %s: %w", flagsPath, err)
	}
	if err := writeRunLog(*runLog, res.Applied); err != nil {
		return err
	}

	log.Printf("applyqueue: applied %d, skipped %d already-applied, %d flag(s) on record",
		len(res.Applied), res.Skipped, len(res.Flags))
	return nil
}

// writeRunLog records this run's applied actions where `notify` will find them.
// Always written, even empty, so `notify` can tell "no reviewer actions" apart
// from "applyqueue never ran".
func writeRunLog(path string, applied []queue.Applied) error {
	if applied == nil {
		applied = []queue.Applied{}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(applied, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}
