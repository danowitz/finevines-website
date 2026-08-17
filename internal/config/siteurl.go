package config

import (
	"net/url"
	"strings"
)

const productionHostname = "finevines.biz"

// IsProductionSiteURL is the single source of truth for whether a build or
// deploy targets the public FineVines site. Preview, CDN, legacy, malformed,
// and unset URLs fail closed.
func IsProductionSiteURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Hostname() == "" {
		return false
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	return host == productionHostname || host == "www."+productionHostname
}
