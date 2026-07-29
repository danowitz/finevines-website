# Fine Vines — Design System

A warm, old-world wine aesthetic for **Fine Vines**, a licensed Illinois wholesale
distributor of fine wine. This is a *visual rework* of the existing site
(finevines.com), not a rebrand — the logo and palette are the anchor.

> **Audience is trade-only** — sommeliers, buyers, retailers, restaurants. By law Fine
> Vines sells only to licensed Illinois retailers and restaurants. Credibility and a
> clean, searchable portfolio matter more than consumer hype.

The brand stands on three words used everywhere: **Service · Quality · Expertise.**
Every bottle is held under temperature and humidity control from winery to door; the
sales team carries 200+ years of combined trade experience.

---

## Sources
- **Logo:** `uploads/finevines-logo.png` → `assets/logo/finevines-logo.png` (provided by client).
- **Live site (reference only):** finevines.com — Home, Portfolio (producer + product detail), About Us, News & Events, Contact. Producer names, the cold-chain story, and the "service company" voice are lifted from there.
- **No codebase or Figma was provided** — tokens, components, and the UI kit are an original system built to the brief, anchored on the logo's two colors.

---

## CONTENT FUNDAMENTALS — how Fine Vines writes

**Voice.** First-person plural, warm and confident, never salesy. *"We search for the
best expressions of fruit and terroir in every wine we represent."* The reader is
addressed as **you**, a trade professional: *"…kept under temperature and humidity
control from the winery to your door."*

**Tone.** Quietly authoritative and craft-focused. Wine is *"an expression of an
artisan's craft,"* not a commodity. Service is the recurring theme: *"At day's end,
we're a service company."* Humble about the work (drivers, warehouse, picking orders),
proud about the producers.

**Casing.** Sentence case for body and headlines. **Eyebrows / overlines are UPPERCASE
with wide tracking** ("THE PORTFOLIO", "SERVICE · QUALITY · EXPERTISE", "NEWS & EVENTS").
Producer names print as overlines above wine names. French/Italian wine names keep their
accents and « guillemets » (e.g. *Saint-Aubin 1er Cru « Derrière chez Édouard »*).

**Vocabulary.** Trade-accurate: producer, importer, terroir, varietal, vintage, closure,
appellation, allocation, cold-chain, Illinois Liquor License, credit application. Numbers
are concrete: "200+ years," "750ml," "12 × 750ml case pack."

**Emoji:** never. **Exclamation points:** rare. Bottle/wine emoji are off-brand — the
mood is a wine list, not a party.

**CTAs** are short and imperative: *View Our Portfolio · Become a Customer · Credit
Application · Request Samples · Contact Sales.*

---

## VISUAL FOUNDATIONS

**Overall mood.** Old-world wine cellar meets a clean trade catalog: deep bordeaux,
parchment and cork, brass, vineyard green, warm near-black ink. Editorial, print-rooted,
restrained. Cool grays are avoided entirely — *every* neutral is warm.

**Color.** Anchored on the logo's two hues — **vine magenta `#83064f`** (the "FINE")
and **vineyard olive `#909020`** (the "VINES"). For large fields the magenta deepens to
**bordeaux `#6b1630` / `#3d0e1c`** (primary). **Brass `#c2a14e`** is the single metallic
accent (rules, focus rings, eyebrows, download CTAs). Grounds are **parchment
`#faf6ee` / `#f4ece0`** and **cork** browns. Text is **warm near-black ink `#1c1410`**.
Status colors are muted and earthy (olive success, ochre warning, brick danger, slate
info). Full scales in `tokens/colors.css`; semantic aliases (`--color-primary`,
`--surface-card`, `--text-body`, `--border-default`…) are the intended product API.

**Type.** High-contrast serif headlines + clean sans for data.
- **Display — Cormorant Garamond** (semibold, tight tracking, occasional italic in
  bordeaux for emphasis). All headings.
- **Body — EB Garamond.** Producer stories, tasting notes, intros. Generous 1.65 leading.
- **Data / UI — Archivo.** Catalog metadata, labels, buttons, nav — uppercase + wide
  tracking for labels, tabular numerals for specs.
Scale ~1.25 on a 16px base; hero up to 72px. See `tokens/typography.css`.

**Spacing & layout.** 8px rhythm (`tokens/spacing.css`). Centered containers
(max 1240px; 760px for prose). Generous section padding (~80px). Sticky header (84px).
Catalog uses a fixed left facet rail + responsive card grid.

**Backgrounds.** Parchment page ground; bordeaux-900 for dark bands, footer, and
photo-overlay panels. Hero/banner imagery is **vineyard-at-sunset photography** with a
dark protection gradient at the bottom for legible text — in this kit it is stood in by
a warm layered gradient + film grain (`VineyardBg`), **to be replaced by real photos**.
No bluish gradients, no decorative blobs.

**Imagery vibe.** Warm, golden-hour, slightly desaturated; a faint grain. Bottle/label
shots on parchment. When a photo is missing, use the branded **parchment + producer-initials
placeholder** (see `WineCard`), never a gray box.

**Borders & corners.** Small, classic radii — 2px (`--radius-sm`) for buttons/tags/chips,
4px (`--radius-md`) for cards. Nothing pill-shaped except optional avatars. Default object
boundary is a **hairline cork border** (`--border-hairline #e4d8c6`).

**Shadows.** Soft and **warm-tinted (brown, never gray)** — `--shadow-xs/sm/md/lg`. Cards
rest at `xs`, lift to `md` on hover. No hard or neon glows.

**Cards.** White surface, 1px hairline border, 4px radius, `shadow-xs`. On hover: rise
~3px and deepen to `shadow-md`. Producer/spec panels may use the parchment-alt surface.

**Motion.** Measured and tasteful — fades and short translates, **no bounce**.
`--dur-fast 120ms` (hovers), `--dur-base 220ms` (cards), eased with `--ease-standard`.
Respect `prefers-reduced-motion`.

**Hover / press.** Primary buttons darken bordeaux on hover; secondary (outlined) fills
bordeaux; ghost gets a parchment wash; brass deepens. Tags fill bordeaux when active.
Links underline with a brass underline on hover. No shrink-on-press; focus shows a 2px
**brass** ring.

**Transparency & blur.** Sparingly: the sticky header is parchment at 92% with a small
backdrop blur; photo overlays use bordeaux gradients. No frosted-glass everywhere.

**Signature motif.** A hairline rule with a **centered brass diamond** (`.fv-rule`)
separates sections, paired with the uppercase brass eyebrow.

---

## ICONOGRAPHY

Fine Vines is **typographic and photographic first** — icons are deliberately scarce.

- **No brand icon font or SVG icon set existed** in the source material, so none ships here.
- **Micro-controls** use a few restrained Unicode glyphs sized to the text: caret `▾`
  (selects, collapsible facets), check `✓` (checked facet), search `⌕`, remove `✕`,
  back `←`. These read as fine-line marks and match the editorial tone.
- **For richer product needs** (any future app surface), use **[Lucide](https://lucide.dev)**
  via CDN — thin 1.5px stroke, rounded caps — which best matches the brand's light,
  classic line. Tint icons with `--text-muted`, `--bordeaux-700`, or `--brass-600`; never
  multicolor. *(This is a substitution recommendation, not an existing brand asset — flag if
  the client has a preferred set.)*
- **Emoji: never.**
- The **brass diamond** in `.fv-rule` is the closest thing to a brand ornament — prefer it
  over decorative icons.

---

## VISUAL CAVEATS / SUBSTITUTIONS
- **Fonts** are loaded from **Google Fonts CDN** (`tokens/fonts.css`) as brand-appropriate
  choices — Fine Vines has no licensed brand fonts on file. If real font binaries exist,
  drop them in and convert to `@font-face`. *(This is why the manifest reports 0 fonts —
  the closure uses `@import`, not `@font-face`.)*
- **Photography** (hero/banners) and **bottle-label images** are placeholders; supply real assets.
- **Icons** — see Iconography; Lucide is a recommended substitute, not an existing asset.

---

## INDEX — what's in this project

**Global entry:** `styles.css` (consumers link this one file — it `@import`s everything below).

**Tokens** (`tokens/`)
- `fonts.css` — webfont loading (Cormorant Garamond, EB Garamond, Archivo).
- `colors.css` — full brand scales + semantic aliases.
- `typography.css` — families, sizes, weights, leading, tracking.
- `spacing.css` — 8px scale + layout sizes.
- `effects.css` — radii, borders, warm shadows, motion, image overlays.
- `base.css` — element resets, heading rhythm, `.fv-eyebrow` / `.fv-rule` utilities.

**Components**
- `components/core/` — `Button`, `Tag`, `Badge`, `Input`, `Select`, `Eyebrow`.
- `components/catalog/` — `WineCard`, `ProducerCard`, `FacetGroup`, `SpecTable`.
- Mounted from `window.FineVinesDesignSystem_d87fe4`. Each has `.d.ts` + `.prompt.md`.

**UI Kit**
- `ui_kits/website/` — interactive Fine Vines trade site (Home, Portfolio, Product,
  Producer, About, News & Events, Contact). See its `README.md`.

**Foundation cards** (`guidelines/cards/`) — specimen cards for the Design System tab
(Colors, Type, Spacing, Brand).

**Assets** (`assets/logo/`) — the Fine Vines wordmark.

**Skill** — `SKILL.md` makes this folder usable as a downloadable Agent Skill.
