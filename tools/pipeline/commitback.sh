#!/usr/bin/env bash
# Commit the run's state back to master.
#
# Runs AFTER the deploy, so by the time we get here the bot's data/ files are
# already the ones live on the CDN. That is the whole reason this script
# resolves conflicts in the bot's favour: keeping a human's concurrent edit
# would leave the repo describing something other than what is published.
#
# The pathspec below must stay narrow. `git add -A` would sweep in the Linux
# helper binaries built earlier in the job — .gitignore lists only the .exe
# names, so bare `finevines`, `imgcheck` and `imgnorm` are untracked but not
# ignored.
set -euo pipefail

REMOTE="${PIPELINE_REMOTE:-origin}"
BOT_PATHS=(data assets/img/wines .bunny-manifest.json)

# A rebase left in progress is worse than a failed run: the next run starts in
# a checkout git refuses to work in, and the failure looks like something else
# entirely. Every exit goes through here, including ones added later.
cleanup() {
  if [ -d "$(git rev-parse --git-path rebase-merge)" ] ||
     [ -d "$(git rev-parse --git-path rebase-apply)" ]; then
    echo "leaving no rebase in progress"
    git rebase --abort || true
  fi
}
trap cleanup EXIT

git config user.name "${PIPELINE_BOT_NAME:-finevines-pipeline[bot]}"
git config user.email "${PIPELINE_BOT_EMAIL:-215369143+finevines-pipeline[bot]@users.noreply.github.com}"

git add "${BOT_PATHS[@]}"
if git diff --cached --quiet; then
  echo "nothing changed this run — no commit"
  exit 0
fi
git commit -m 'pipeline: nightly run [skip ci]'

# Is a bot-owned path? Anything else conflicting means the pathspec assumption
# broke and a human needs to look.
bot_owned() {
  case "$1" in
    data/*|assets/img/wines/*|.bunny-manifest.json) return 0 ;;
    *) return 1 ;;
  esac
}

# resolve_conflicts settles a stopped rebase in the pipeline's favour and
# continues it. Returns non-zero (aborting the whole script, via set -e at the
# call site and the EXIT trap) when it is not safe to decide.
#
# Do not call this from an `if`/`&&`/`||` condition: bash suspends errexit for
# the whole of a function invoked that way, and the git commands inside would
# stop being fatal.
resolve_conflicts() {
  local conflicts f stages
  # core.quotepath=false: without it git C-quotes any path with a non-ASCII
  # byte, and bot_owned would then be handed a path wrapped in literal quotes
  # and abort a run it should have resolved.
  conflicts=$(git -c core.quotepath=false diff --name-only --diff-filter=U)

  # Not every rebase failure is a conflict. A tracked file dirty in the working
  # tree — anything outside BOT_PATHS, which `git add` above never staged —
  # makes `git rebase` refuse before it starts. Calling that a conflict sends
  # the operator hunting for a merge that never happened, and the follow-up
  # `git rebase --continue` just prints "no rebase in progress".
  if [ -z "$conflicts" ]; then
    echo "rebase failed but nothing is conflicted — not a merge problem"
    echo "most likely a tracked file outside the pipeline's pathspec is dirty:"
    git status --short || true
    return 1
  fi

  echo "rebase hit conflicts:"
  echo "$conflicts"

  # Read line by line: this repo tracks paths with spaces in them, and `for f
  # in $conflicts` would hand bot_owned a fragment of one.
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if ! bot_owned "$f"; then
      echo "CONFLICT IN A PATH THE PIPELINE DOES NOT OWN: $f"
      echo "aborting rather than guessing — resolve by hand"
      return 1
    fi
    # In a rebase, --theirs is the commit being replayed: ours. Take the whole
    # file, not a hunk-level merge — a hunk-merged 5MB JSON array can parse and
    # still be semantically wrong.
    echo "  $f — taking the pipeline's version (it is what was deployed)"
    git diff -- "$f" | head -40 || true

    # Read the index entries into a variable and match with a here-string
    # rather than piping into `grep -q`: grep -q closes the pipe on its first
    # match, and under `set -o pipefail` a SIGPIPE'd git would make a MATCH
    # look like a miss — i.e. silently delete a file we meant to keep.
    stages=$(git ls-files --stage -- "$f")
    if grep -q '^[0-7]* [0-9a-f]* 3' <<< "$stages"; then
      git checkout --theirs -- "$f"
      git add -- "$f"
    else
      # Modify/delete with no stage 3: the pipeline DELETED this file and a
      # human modified it. internal/enrich.writeImageFile removes the sibling
      # .jpg whenever it writes an .svg label, and 551 photos were withdrawn
      # that way in one pass on 2026-08-06 — so this is the ordinary case, not
      # an exotic one. `git checkout --theirs` cannot express it ("does not
      # have their version") and used to kill the run mid-rebase. The bot still
      # wins; the bot's version of this file is that it is gone.
      echo "  $f — the pipeline removed this file; keeping it removed"
      git rm --quiet -- "$f"
    fi
  done <<< "$conflicts"

  GIT_EDITOR=true git rebase --continue
}

# The merge is only safe if the result is still valid JSON. A corrupt
# wines.json would be committed, pushed, and only discovered by tomorrow's
# enrich failing — long after the deploy that used it.
validate_json() {
  local f
  for f in data/wines.json data/hot-sellers.json .bunny-manifest.json; do
    [ -f "$f" ] || continue
    node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" \
      || { echo "$f is not valid JSON after the merge — refusing to push"; exit 1; }
    echo "$f parses"
  done
}

git fetch "$REMOTE" master
if ! git rebase "$REMOTE/master"; then
  resolve_conflicts
fi
validate_json

if ! git push "$REMOTE" HEAD:master; then
  # The gap between the fetch above and this push is small but real: a human
  # landing a commit inside it gets the push rejected as non-fast-forward.
  # Rebase onto whatever arrived and try once, exactly as the inline block this
  # script replaced did. Same conflict rules, same JSON gate — a collision
  # outside the pipeline's paths still aborts rather than being forced through.
  echo "push rejected — refetching and retrying once"
  git fetch "$REMOTE" master
  if ! git rebase "$REMOTE/master"; then
    resolve_conflicts
  fi
  validate_json
  git push "$REMOTE" HEAD:master
fi
