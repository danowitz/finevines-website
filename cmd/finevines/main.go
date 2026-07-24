package main

import (
	"fmt"
	"os"

	"github.com/gritautomation/finevines-website/internal/build"
	"github.com/gritautomation/finevines-website/internal/config"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cfg, err := config.Load(".env")
	if err != nil {
		fatal(err)
	}
	var runErr error
	switch os.Args[1] {
	case "enrich":
		runErr = runEnrich(cfg)
	case "build":
		runErr = runBuild(cfg)
	case "redirects":
		runErr = runRedirects(cfg)
	case "deploy":
		runErr = runDeploy(cfg)
	default:
		usage()
		os.Exit(2)
	}
	if runErr != nil {
		fatal(runErr)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: finevines <enrich|build|redirects|deploy>")
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "finevines:", err)
	os.Exit(1)
}

// runBuild renders data/*.json + assets/ + templates/*.tmpl into dist/ — see
// internal/build.Run for the actual page-generation logic.
func runBuild(cfg config.Config) error {
	return build.Run("data", "assets", "templates", "dist", cfg.SiteBaseURL)
}

// Stubs — replaced by later tasks (16, 20, 18 respectively).
func runEnrich(cfg config.Config) error    { return fmt.Errorf("enrich: not implemented yet") }
func runRedirects(cfg config.Config) error { return fmt.Errorf("redirects: not implemented yet") }
func runDeploy(cfg config.Config) error    { return fmt.Errorf("deploy: not implemented yet") }
