package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"

	"github.com/gritautomation/finevines-website/internal/config"
	"github.com/gritautomation/finevines-website/internal/model"
	"github.com/gritautomation/finevines-website/internal/notify"
	"github.com/gritautomation/finevines-website/internal/queue"
)

// runNotify emails the digest for the run that just finished — and ONLY if that
// run changed something (design spec §A step 7). A digest that arrives every
// night saying "no changes" stops being read, and the whole point of it is that
// somebody reads it: with images publishing themselves, this email is what
// stands between a wrong bottle going live and a human noticing.
//
// The run's "before" state is a snapshot the workflow copies aside immediately
// after checkout, before applyqueue touches anything. That is more reliable than
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
		"this run's applied review-console actions, written by applyqueue")
	dry := flags.Bool("dry", false,
		"print the digest instead of sending it (no Postmark call, no credentials needed)")
	if err := flags.Parse(args); err != nil {
		return err
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

	requiredEnv := []struct{ name, value string }{
		{"POSTMARK_TOKEN", cfg.PostmarkToken},
		{"FINEVINES_NOTIFY_FROM", cfg.NotifyFrom},
		{"FINEVINES_NOTIFY_TO", cfg.NotifyTo},
	}
	for _, req := range requiredEnv {
		if req.value == "" {
			return fmt.Errorf("notify: set %s in .env (or the environment) before sending the digest", req.name)
		}
	}
	to := notify.Recipients(cfg.NotifyTo)

	sender := notify.NewPostmarkSender(cfg.PostmarkToken, http.DefaultClient)
	if err := sender.Send(context.Background(), cfg.NotifyFrom, to, msg); err != nil {
		return fmt.Errorf("notify: %w", err)
	}

	log.Printf("notify: digest sent to %d recipient(s) — %s", len(to), msg.Subject)
	log.Printf("notify: %d new, %d delisted, %d photographs, %d notes rewritten, %d review fixes",
		len(d.NewWines), len(d.Delisted), len(d.NewImages), len(d.TextRefreshed), len(d.QueueActions))
	return nil
}

// loadApplied reads applyqueue's run log. A missing file means applyqueue did not
// run in this workflow (a build-only re-run, or a local invocation) — not an
// error, just no reviewer fixes to report.
func loadApplied(path string) ([]queue.Applied, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var applied []queue.Applied
	if err := json.Unmarshal(data, &applied); err != nil {
		return nil, err
	}
	return applied, nil
}
