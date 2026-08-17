package collectioneditorial

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/gritautomation/finevines-website/internal/model"
)

type Draft struct {
	Eyebrow     string   `json:"eyebrow"`
	Heading     string   `json:"heading"`
	Paragraphs  []string `json:"paragraphs"`
	Sources     []Source `json:"sources"`
	Publishable bool     `json:"publishable"`
	Changed     bool     `json:"changed"`
}

type Reason string

const (
	NewCollection   Reason = "new"
	MaterialChange  Reason = "material-change"
	ScheduledReview Reason = "scheduled-review"
)

type Assignment struct {
	Candidate Candidate
	Previous  *Entry
	Reason    Reason
}

// Researcher is the true-external seam. Production uses OpenAI web search;
// tests use a small in-memory adapter. Sync owns every other decision.
type Researcher interface {
	Research(context.Context, Assignment) (Draft, error)
}

type Options struct {
	Limit           int
	ReviewAfterDays int
	Now             func() time.Time
	Logf            func(string, ...any)
}

type Report struct {
	Discovered int
	Attempted  int
	Published  int
	Failed     int
	Deferred   int
	Current    int
}

// Sync checkpoints after every research attempt. Curated entries are never
// overwritten, generated entries are reused while their identity fingerprint
// is current, and failures cool down for 30 days.
func Sync(ctx context.Context, path string, wines []model.Wine, researcher Researcher, options Options) (Report, error) {
	library, err := Load(path)
	if err != nil {
		return Report{}, err
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.Logf == nil {
		options.Logf = func(string, ...any) {}
	}
	if options.Limit <= 0 {
		options.Limit = 50
	}
	now := options.Now().UTC()
	candidates := Discover(wines)
	report := Report{Discovered: len(candidates)}

	type task struct {
		candidate Candidate
		reason    Reason
		existing  *Entry
	}
	var newTasks, changedTasks, reviewTasks []task
	if options.ReviewAfterDays <= 0 {
		options.ReviewAfterDays = 365
	}
	for _, candidate := range candidates {
		existing, exists := library.raw(candidate.Kind, candidate.Slug)
		if exists && existing.Mode == "curated" {
			report.Current++
			continue
		}
		if exists && existing.RetryFingerprint == candidate.Fingerprint && existing.RetryAfter != "" {
			if retryAt, err := time.Parse("2006-01-02", existing.RetryAfter); err == nil && retryAt.After(now) {
				report.Deferred++
				continue
			}
		}
		var previous *Entry
		if exists {
			copy := existing
			previous = &copy
		}
		switch {
		case !exists || !existing.Publishable():
			newTasks = append(newTasks, task{candidate: candidate, reason: NewCollection, existing: previous})
		case existing.Fingerprint != candidate.Fingerprint:
			changedTasks = append(changedTasks, task{candidate: candidate, reason: MaterialChange, existing: previous})
		default:
			reviewed, err := time.Parse("2006-01-02", existing.ReviewedAt)
			if err != nil || reviewed.AddDate(0, 0, options.ReviewAfterDays).Before(now) {
				reviewTasks = append(reviewTasks, task{candidate: candidate, reason: ScheduledReview, existing: previous})
			} else {
				report.Current++
			}
		}
	}

	// New pages always win. Material changes run only when every live page has
	// an article. Scheduled reviews run only when nothing new or changed needs
	// attention, so the workflow never rewrites old pages ahead of a launch.
	tasks := newTasks
	if len(tasks) == 0 {
		tasks = changedTasks
		report.Deferred += len(reviewTasks)
	} else {
		report.Deferred += len(changedTasks) + len(reviewTasks)
	}
	if len(tasks) == 0 {
		tasks = reviewTasks
	}
	for _, task := range tasks {
		candidate := task.candidate
		existing := Entry{}
		exists := task.existing != nil
		if exists {
			existing = *task.existing
		}
		if report.Attempted >= options.Limit {
			report.Deferred++
			continue
		}
		if err := ctx.Err(); err != nil {
			return report, err
		}
		report.Attempted++
		options.Logf("collection editorial: researching %s %q (%s)", candidate.Kind, candidate.Name, task.reason)
		draft, researchErr := researcher.Research(ctx, Assignment{Candidate: candidate, Previous: task.existing, Reason: task.reason})
		entry := Entry{Kind: candidate.Kind, Slug: candidate.Slug, Name: candidate.Name, Mode: "generated", Fingerprint: candidate.Fingerprint}
		preserved := false
		if researchErr == nil && task.reason == ScheduledReview && !draft.Changed {
			entry = existing
			entry.Fingerprint = candidate.Fingerprint
			entry.ReviewedAt = now.Format("2006-01-02")
			entry.RetryAfter = ""
			entry.LastError = ""
			entry.RetryFingerprint = ""
			preserved = true
		} else if researchErr == nil && draft.Publishable {
			entry.Eyebrow = strings.TrimSpace(draft.Eyebrow)
			entry.Heading = strings.TrimSpace(draft.Heading)
			entry.Paragraphs = trimStrings(draft.Paragraphs)
			entry.Sources = draft.Sources
			entry.ReviewedAt = now.Format("2006-01-02")
			if err := validateEntry(entry); err != nil {
				researchErr = err
			}
		} else if researchErr == nil {
			researchErr = fmt.Errorf("research did not find enough authoritative information")
		}
		if researchErr != nil {
			report.Failed++
			// Keep still-valid copy visible while a changed identity is retried.
			if exists && existing.Publishable() {
				entry = existing
			} else {
				// Validation can fail after draft fields have been copied into entry.
				// Persist only retry metadata, never the rejected editorial itself.
				entry = Entry{Kind: candidate.Kind, Slug: candidate.Slug, Name: candidate.Name, Mode: "generated", Fingerprint: candidate.Fingerprint}
			}
			entry.RetryFingerprint = candidate.Fingerprint
			entry.RetryAfter = now.AddDate(0, 0, 30).Format("2006-01-02")
			entry.LastError = truncateError(researchErr.Error())
			options.Logf("collection editorial: %s %q deferred: %v", candidate.Kind, candidate.Name, researchErr)
		} else if preserved {
			report.Current++
		} else {
			report.Published++
		}
		library.put(entry)
		if err := Save(path, library); err != nil {
			return report, err
		}
	}
	return report, nil
}

func trimStrings(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			out = append(out, value)
		}
	}
	return out
}

func truncateError(value string) string {
	const max = 240
	value = strings.TrimSpace(value)
	if len(value) <= max {
		return value
	}
	return value[:max]
}
