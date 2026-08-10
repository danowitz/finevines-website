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

git fetch "$REMOTE" master

if ! git rebase "$REMOTE/master"; then
  conflicts=$(git diff --name-only --diff-filter=U)
  echo "rebase hit conflicts:"
  echo "$conflicts"

  for f in $conflicts; do
    if ! bot_owned "$f"; then
      echo "CONFLICT IN A PATH THE PIPELINE DOES NOT OWN: $f"
      echo "aborting rather than guessing — resolve by hand"
      git rebase --abort
      exit 1
    fi
    # In a rebase, --theirs is the commit being replayed: ours. Take the whole
    # file, not a hunk-level merge — a hunk-merged 5MB JSON array can parse and
    # still be semantically wrong.
    echo "  $f — taking the pipeline's version (it is what was deployed)"
    git diff -- "$f" | head -40 || true
    git checkout --theirs -- "$f"
    git add -- "$f"
  done

  GIT_EDITOR=true git rebase --continue
fi

# The merge above is only safe if the result is still valid JSON. A corrupt
# wines.json would be committed, pushed, and only discovered by tomorrow's
# enrich failing — long after the deploy that used it.
for f in data/wines.json data/hot-sellers.json .bunny-manifest.json; do
  [ -f "$f" ] || continue
  node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" \
    || { echo "$f is not valid JSON after the merge — refusing to push"; exit 1; }
  echo "$f parses"
done

git push "$REMOTE" HEAD:master
