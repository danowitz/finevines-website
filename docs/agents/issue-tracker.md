# Issue tracker: GitHub

Issues and specifications for this repository live in GitHub Issues at `danowitz/finevines-website`. Use the `gh` CLI from this checkout so repository context is resolved from the configured remote.

## Conventions

- Create one GitHub issue for each specification or implementation ticket.
- Apply `ready-for-agent` to published build work.
- Publish dependency tickets before the tickets they block.
- Represent blocking edges with GitHub's native issue dependencies when available; otherwise include an explicit `Blocked by: #...` section.
- Do not treat pull requests as incoming feature requests.
- Do not close or rewrite a parent specification when completing a child ticket.

## Skill operations

- Create: `gh issue create --title "..." --body-file <file>`
- Read: `gh issue view <number> --comments`
- Label: `gh issue edit <number> --add-label ready-for-agent`
- Close: `gh issue close <number> --comment "..."`

When an engineering skill says to publish to the issue tracker, create a GitHub issue in this repository.
