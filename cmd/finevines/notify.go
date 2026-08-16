package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"os"
	"strconv"

	"github.com/gritautomation/finevines-website/internal/config"
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/notify"
)

// runNotify emails the digest for the run that just finished — and ONLY if that
// run changed something (design spec §A step 7). A digest that arrives every
// night saying "no changes" stops being read, and the whole point of it is that
// somebody reads it: with images publishing themselves, this email is what
// stands between a wrong bottle going live and a human noticing.
//
// The run's "before" state is a snapshot the workflow copies aside immediately
// after checkout, before hosted review actions touch anything. That is more reliable than
// diffing git: by the time notify runs, the commit-back has already landed, so
// HEAD is the AFTER state and HEAD~1 may be a human's commit rather than the
// start of this run.
func runNotify(cfg config.Config, args []string) error {
	// Named `flags`, not `fs`: this file needs io/fs for fs.ErrNotExist below,
	// and the conventional flag-set name would shadow it.
	flags := flag.NewFlagSet("notify", flag.ContinueOnError)
	beforePath := flags.String("before", ".run/wines-before.json",
		"the catalog as it stood at the start of the run (copied aside after checkout)")
	appliedPath := flags.String("applied", ".run/queue-applied.json",
		"this run's applied review-console actions, written by reviewapply")
	dry := flags.Bool("dry", false,
		"print the digest instead of sending it (no relay connection, no credentials needed)")
	if err := flags.Parse(args); err != nil {
		return err
	}

	// Checked, not just loaded. model.LoadWines treats a missing file as an empty
	// catalog — correct for data/wines.json on a first run, catastrophic for the
	// baseline of a diff: every wine in the portfolio reads as new, and the
	// client is mailed a digest announcing five thousand arrivals. There is no
	// safe default for a missing baseline, so this refuses rather than guesses.
	if _, err := os.Stat(*beforePath); err != nil {
		return fmt.Errorf("notify: before-snapshot not found: %s — refusing to diff against an empty baseline "+
			"(the workflow copies data/wines.json aside right after checkout; by hand, see docs/operations.md)",
			*beforePath)
	}
	before, err := model.LoadWines(*beforePath)
	if err != nil {
		return fmt.Errorf("notify: load %s: %w", *beforePath, err)
	}
	after, err := model.LoadWines("data/wines.json")
	if err != nil {
		return fmt.Errorf("notify: load data/wines.json: %w", err)
	}
	applied, err := loadApplied(*appliedPath)
	if err != nil {
		return fmt.Errorf("notify: load %s: %w", *appliedPath, err)
	}

	d := notify.Diff(before, after, applied, cfg.SiteBaseURL)
	if !d.Changed() {
		log.Printf("notify: the run changed nothing — no digest sent")
		return nil
	}
	msg := notify.Render(d, cfg.SiteBaseURL)

	if *dry {
		fmt.Println("Subject:", msg.Subject)
		fmt.Println()
		fmt.Println(msg.TextBody)
		return nil
	}

	// The relay endpoint has no defaults: guessing a host or a port would fail
	// at 2:15am in a workflow log nobody is watching, so every piece is demanded
	// by name up front.
	requiredEnv := []struct{ name, value string }{
		{"FINEVINES_SMTP_HOST", cfg.SMTPHost},
		{"FINEVINES_SMTP_PORT", portValue(cfg.SMTPPort)},
		{"FINEVINES_SMTP_USER", cfg.SMTPUser},
		{"FINEVINES_SMTP_PASS", cfg.SMTPPass},
		{"FINEVINES_NOTIFY_FROM", cfg.NotifyFrom},
		{"FINEVINES_NOTIFY_TO", cfg.NotifyTo},
	}
	for _, req := range requiredEnv {
		if req.value == "" {
			return fmt.Errorf("notify: set %s in .env (or the environment) before sending the digest", req.name)
		}
	}
	to := notify.Recipients(cfg.NotifyTo)

	// The constructed sender carries its own send timeout. This is the last step
	// of the nightly pipeline, and net/smtp has no timeout of its own, so an
	// unbounded send would let one stalled relay hold the whole job open until
	// its multi-hour workflow timeout. That bound is why context.Background() is
	// enough here — the deadline lives on the sender.
	sender := notify.NewSMTPSender(cfg.SMTPHost, cfg.SMTPPort, cfg.SMTPUser, cfg.SMTPPass)
	if err := sender.Send(context.Background(), cfg.NotifyFrom, to, msg); err != nil {
		return fmt.Errorf("notify: %w", err)
	}

	log.Printf("notify: digest sent to %d recipient(s) — %s", len(to), msg.Subject)
	log.Printf("notify: %d new, %d delisted, %d photographs, %d notes rewritten, %d review fixes",
		len(d.NewWines), len(d.Delisted), len(d.NewImages), len(d.TextRefreshed), len(d.QueueActions))
	return nil
}

// portValue renders the relay port for the required-env check above, so an
// unset port reads as the missing FINEVINES_SMTP_PORT it is rather than as a
// connection attempt to port 0.
func portValue(port int) string {
	if port <= 0 {
		return ""
	}
	return strconv.Itoa(port)
}

// loadApplied reads reviewapply's run log. A missing file means reviewapply did not
// run in this workflow (a build-only re-run, or a local invocation) — not an
// error, just no reviewer fixes to report.
func loadApplied(path string) ([]notify.AppliedAction, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var applied []notify.AppliedAction
	if err := json.Unmarshal(data, &applied); err != nil {
		return nil, err
	}
	return applied, nil
}
