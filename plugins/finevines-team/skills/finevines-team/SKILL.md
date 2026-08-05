---
name: finevines-team
description: Use when adding, removing, or editing a team member on the FineVines About page.
---

# FineVines Team Roster

This skill turns a short conversation with Barbara (or whoever on staff is updating the roster) into an updated
`data/team.json`, and optionally publishes it to finevines.com. Barbara isn't a developer — no jargon, no talk of
JSON, arrays, git, or "the build." To her this is just "add Jane to the About page" or "take George's old photo
down."

## Step 1 — Read the current roster

Read `data/team.json`. It's an array of team members, and array order **is** the display order on the About
page — top to bottom, left to right in the team grid.

## Step 2 — Work out the operation

Figure out from the user's request whether this is an **add**, a **remove**, or an **edit**, then follow the
matching steps below.

**The headline count takes care of itself.** The About page's "The House" heading — "Ten people. Two hundred
years in the business." — is not typed anywhere: the site build counts `team.json` and writes the number out
itself. Remove someone and it reads "Nine people" after the next build; add someone and it climbs back up. So
when the user asks for the count to be fixed ("it needs to say nine now"), the roster change **is** the fix —
never edit the page templates to change the number, and tell the user in plain language that the headline
updates itself.

### Add

Ask conversationally, one question per turn — don't front-load a form:

1. **Name**
2. **Role** (e.g. "Sales", "Office Manager", "Founder & President")
3. **Email**
4. **Photo** (optional) — "Do you have a photo for them?" If they give you a file, copy it to
   `assets/img/team/<slugified-name>.jpg` (see Step 3 for the slug rule) and set `photoPath` to that site-relative
   path, e.g. `assets/img/team/jane-doe.jpg` — no leading slash. The About page template adds the leading slash
   itself (`<img src="/{{.PhotoPath}}">`), so a leading slash in the stored value would produce a broken double
   slash. If there's no photo, don't set `photoPath` at all — leave the key out entirely (the About page only
   renders an `<img>` when `PhotoPath` is present).
5. **Internal note** (optional) — a staff-only reminder about a pending roster detail. Notes are never rendered
   on the public About page. Skip this question unless there is something the next editor needs to verify.

Append the new member to the **end** of the array unless the user asks for a specific position — that's where
they'll land in the team grid.

### Remove

Confirm which member by name before touching anything — read back their current role so the user can confirm it's
the right person (helpful if two people share a first name). For a removal, this read-back **is** the Step 5
preview — one confirmation is enough; don't make the user confirm the same person twice. Once confirmed, delete
that entry from the array and leave every other member untouched, in their existing order.

### Edit

Show the member's current values (name, role, email, and note/photo if set), then apply only the fields the user
asked to change. Leave everything else about that entry, and every other member, untouched.

## Step 3 — Slug for photo filenames

When a photo needs a filename, slugify the person's name the same way news posts are slugged: lowercase, strip
punctuation and accents, replace spaces with single hyphens, trim leading/trailing hyphens. E.g. "Steven Fladung" →
`steven-fladung`, so the photo would be saved as `assets/img/team/steven-fladung.jpg`.

## Step 4 — The data contract

Each member object must have exactly these keys — no more, no fewer (this must match the `TeamMember` struct in
`internal/model/model.go` exactly, or the site build will silently drop or ignore fields):

```json
{
  "name": "Jane Doe",
  "role": "Sales",
  "email": "jane@finevines.com",
  "photoPath": "assets/img/team/jane-doe.jpg",
  "note": "new portrait requested"
}
```

- `name`, `role`, `email` are always present.
- `photoPath` is included **only** if a photo file was provided for this member — omit the key entirely otherwise
  (don't write `"photoPath": ""`).
- `note` is included **only** for an internal reminder — omit the key entirely otherwise (don't write
  `"note": ""`). Never put public biography copy here; the site intentionally does not render this field.

## Step 5 — Show the change, get approval, write the file

Show the user the entry you're about to add, remove, or change — plain language is fine ("Here's what I've got for
Jane: Sales, jane@finevines.com, with the internal note 'new portrait requested.' Look right?"), or the raw JSON
if they're comfortable with it. Make any edits they ask for.

Once approved, write `data/team.json` as a valid JSON array containing every existing member unchanged (same order,
same fields) plus your add/remove/edit applied.

Then ask: **"Publish now? That updates the live website."**

- **If yes**: from the repo root, run `./finevines.exe build` then `./finevines.exe deploy`. Before reporting
  success, check the rebuilt About page (`dist/about/index.html`) actually shows the change — the new or removed
  name, and the updated "…people." headline count — then report back the summary lines each command prints
  (don't paste the full raw output — just the outcome: pages built, anything deployed, any errors).
- **If no**: tell them the roster is saved and will go out with the next site update.

**Either way, save the change to the repository afterwards** — the site also rebuilds itself automatically from
the repository (nightly and on every push), so a roster change that only lives on this machine gets silently
reverted by the next automatic run. That automatic rebuild is also why "no" to publishing still means "it goes
out with the next automatic update, possibly soon after saving" — say it that way; don't promise the change is
on hold.

Commit directly on the default branch (`master`) — a side branch or PR never reaches the site, and this
instruction overrides any general branch-first habit. This working tree often carries unrelated in-progress
work, so never use `git add -A`, `git add .`, or `git commit -a`: stage by exact path only (`git add`:
`data/team.json`, any copied photo under `assets/img/team/`, and `.bunny-manifest.json` only if a deploy ran).
Commit with a short message like `team: add Jane Doe` / `team: remove Tim Freehan`, and push. If the push fails,
don't block the user — tell them the site part worked (if it did) but the change still needs saving, and to let
GRIT know.

## Voice

This is mostly a data-entry skill, so the copy burden is light. Keep internal notes short and factual, such as
"confirm email" or "new portrait requested." They are reminders for staff, not website copy.

## Boundaries

This skill only ever writes to `data/team.json`, copies a supplied photo into `assets/img/team/`, and runs the
publish-and-save steps above (build, deploy, and a commit limited to those exact files). Never touch
`data/wines.json`, `data/news/`, anything related to Salesforce or the `enrich` pipeline, or any other file in
the repo — in particular, never edit templates to change the About page's people count (it derives from
`team.json` automatically; see Step 2). If the user asks for something outside managing the team roster (posting
news or events, adding a wine, changing site design), tell them that's outside what this skill does.
