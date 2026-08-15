---
name: finevines-team
description: Use when adding, replacing, or removing a photograph for a Salesforce-selected member of the FineVines About page.
---

# FineVines Team Photographs

The About-page roster is automatic. Every nightly run selects active Salesforce users whose role is `Executive`,
`Sales Rep`, or `Back Office`. Salesforce owns each displayed person's name, email, role, addition, and removal.
This skill must never edit those fields or decide who belongs on the page.

## Step 1 — Read the current roster

Read `data/team.json` and find the requested person by name. If they are absent, explain that their Salesforce user
must be active and have one of the three qualifying roles; do not add them manually.

## Step 2 — Work out the photo change

This skill supports only:

- add or replace `photoPath` for an existing selected person;
- remove `photoPath` for an existing selected person;
- add, change, or remove an internal `note` about that person's photograph.

If asked to change a name, email, role, add a person, or remove a person, explain that the change belongs in
Salesforce and will flow to the website on the next nightly run.

For an added or replaced photograph, copy the supplied image to
`assets/img/team/<slugified-name>.jpg` and set `photoPath` to that site-relative path with no leading slash.
Slugify the name by lowercasing it, replacing spaces with hyphens, and removing punctuation.

`note` is an internal reminder only, such as `new portrait requested`. Never put public biography copy there.

## Step 3 — Show and approve the change

Show the proposed photograph/reminder change in plain language and get approval. Then update only `photoPath` or
`note` on the existing member. Preserve the Salesforce-owned `name`, `role`, and `email` exactly, preserve array
order, and leave every other member unchanged.

The nightly Salesforce sync deliberately preserves local `photoPath` and `note` values by matching email first and
name second.

## Step 4 — Publish and save

Ask: **"Publish now? That updates the live website."**

- If yes, run `./finevines.exe build` and `./finevines.exe deploy`, then verify the rebuilt About page.
- If no, explain that the change will go out with the next successful automatic update.

Save the change to the repository afterward. This working tree may contain unrelated work, so stage only the exact
`data/team.json` entry, the supplied photo path, and `.bunny-manifest.json` only if deploy changed it. Never use
`git add -A`, `git add .`, or `git commit -a`.

## Boundaries

Never edit Salesforce-owned `name`, `role`, or `email` values. Never add, remove, or reorder members. Never touch
`data/wines.json`, `data/news/`, the Salesforce query, templates, or any unrelated file. If the roster itself is
wrong, direct the user to correct the Salesforce user's active status or role.
