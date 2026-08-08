// Package label provides the catalog's guaranteed image fallback.
//
// The original implementation invented a product-specific wine label and
// wrapped it around an illustrated bottle. That looked finished, but it also
// looked like packaging. The fallback is now intentionally product-neutral:
// it says that photography is unavailable and makes no claim about the bottle,
// label, colours, typography, or trade dress a buyer will receive.
package label

import "github.com/gritautomation/finevines-website/internal/salesforce"

// Generate returns one deterministic, product-neutral unavailable-image SVG.
// WineRaw is accepted for API compatibility with enrich/build, but no catalog
// value is rendered into the artwork: misspelled or stale source data can never
// become convincing fictional packaging.
func Generate(_ salesforce.WineRaw) []byte {
	return []byte(unavailableSVG)
}

const unavailableSVG = `<svg viewBox="0 0 480 720" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Product image unavailable">
<rect width="480" height="720" fill="#faf8f4"/>
<rect x="35" y="35" width="410" height="650" rx="5" fill="none" stroke="#d8ccbb" stroke-width="1"/>
<g transform="translate(240 278)" fill="none" stroke-linecap="round" stroke-linejoin="round">
  <rect x="-84" y="-58" width="168" height="116" rx="12" stroke="#6b1630" stroke-width="5"/>
  <path d="M-48 -58 L-31 -84 H31 L48 -58" stroke="#6b1630" stroke-width="5"/>
  <circle cx="0" cy="0" r="34" stroke="#a9853d" stroke-width="5"/>
  <path d="M-23 23 L23 -23" stroke="#a9853d" stroke-width="5"/>
</g>
<line x1="155" y1="405" x2="325" y2="405" stroke="#a9853d" stroke-width="1"/>
<text x="240" y="454" text-anchor="middle" font-family="Georgia,serif" font-size="25" letter-spacing="1.8" fill="#3b2d26">Product image unavailable</text>
<text x="240" y="493" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" letter-spacing="2.2" fill="#786a5e">Verified photography pending</text>
<circle cx="240" cy="548" r="3" fill="#a9853d"/>
<path d="M210 548 H232 M248 548 H270" stroke="#a9853d" stroke-width="1"/>
</svg>
`
