# Design brief — Portfolio filter sidebar at scale (Fine Vines)

**For:** Claw Design
**From:** GRIT (Fine Vines website rebuild)
**Deliverable:** visual + interaction design for the portfolio's filter sidebar, handling very long value lists. HTML/CSS mockup or Figma both fine.

---

## Context

Fine Vines is a wholesale wine/liquor distributor. We rebuilt their public catalog
(`/portfolio/`) as a fast static site: the browser downloads one compact JSON index of
~2,665 wines and does all filtering, sorting, search, and pagination in-page (no server).
The current sidebar filters work correctly — the problem is purely **visual/UX at scale**.

The brand is editorial, old-world wine-trade: bordeaux / brass / parchment / ink, serif
display faces. "Pouring elegance with a sommelier's touch." Whatever you design must feel
of a piece with that — restrained and premium, not a SaaS control panel.

## The problem

The sidebar has five filter groups. Their value counts on real data:

| Filter    | Distinct values |
|-----------|-----------------|
| Producer  | **310**         |
| Varietal  | 110             |
| Region    | 109             |
| Vintage   | 28              |
| Country   | 20              |

Today every group is rendered fully expanded as a flat checkbox list. **Producer alone is
310 checkboxes** — an unusable wall on load (you cannot scan it, and it dwarfs the wine
grid). Region and Varietal (~110 each) are nearly as bad. Vintage and Country are fine as-is.

We need an interaction pattern that makes a 300+ value filter genuinely usable while
keeping the small filters simple, and that reads as elegant, not utilitarian.

## What each value looks like

Each filter value is a **label + a live result count** that updates as other filters change:

```
☐ Groffier            38
☐ Benjamin Leroux     33
☐ Damoy               22
```

The count is meaningful — it reflects how many wines that value would yield given the other
active filters, and a value can drop to 0 (we currently dim + disable those). Please design
for: normal, checked/active, hover, disabled/zero, and (if relevant) a "selected filters"
summary.

## Candidate directions (pick/refine/replace — your call)

1. **Collapse + filter-within-group (our lean).** Groups start collapsed, each header
   showing its value count, e.g. `Producer (310)`. Opening a large group reveals a small
   "filter…" text box that narrows the list as you type, plus the list caps at ~12 values
   with a "Show all 310" expander. Familiar, scales to any size.
2. **Top-N + show all.** Group stays open but shows only the ~12 most-common values (by
   wine count) with a "Show all" link. Simpler, but finding a rare producer still means
   expanding all 310.
3. **Typeahead + chips.** Replace long checkbox lists with one autocomplete input per big
   filter ("Add producer…"); selections become removable chips. Most compact; **note this
   one requires engineering rework** (see constraints) — the others are drop-in.

You are not limited to these — if you have a stronger pattern for a 300-value filter, propose it.

## Hard constraints (so the design drops into the working engine)

The filtering engine (`assets/js/portfolio.js`) reads the DOM by this contract. **Directions
1 and 2 keep it intact = no code changes; direction 3 or anything that removes checkboxes
needs a paired engineering change (flag it, that's fine).**

- Each selectable value MUST be a real checkbox: `<input type="checkbox" data-facet="<producer|region|varietal|country|vintage>" value="<the value>">`.
- Each checkbox MUST have a sibling `<span class="facet-count">` — the engine writes the live number into it.
- Groups live inside the `<aside class="facets">` sidebar; today each is a `<details class="facet-group facet">`. You may restyle/restructure the group chrome freely as long as the checkbox + `.facet-count` contract survives.
- Must keep working inside the existing **mobile off-canvas drawer** (≤1024px the whole sidebar slides in from the side; there's a close button + backdrop).
- Accessibility: keyboard-operable (the in-group filter box, expanders, and checkboxes must all be reachable/toggleable by keyboard), sensible labels, visible focus states.

## Brand tokens (CSS custom properties already in the site)

```
--bordeaux-700 #6b1630   --bordeaux-800 #531427   (primary wine reds)
--brass-500 #c2a14e      --brass-600 #a9853d       (gold accents, active states)
--parchment-50 #faf6ee   --parchment-200 #ece0cd   (backgrounds, hairlines)
--ink-800 #2c211a        --ink-500 #6e5d4e         (body text, muted text)
Display serif: 'Cormorant Garamond'  ·  Body serif: 'EB Garamond'  ·  UI sans: 'Archivo'
```

Please deliver states for: collapsed group header (with count), expanded group with the
in-group filter box, a value row (normal/hover/checked/disabled-zero), the "show all N"
expander, and how selected filters are surfaced (inline checks vs. a summary of active
filters). Desktop + the mobile drawer.
