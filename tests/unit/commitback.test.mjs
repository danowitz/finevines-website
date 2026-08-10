import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  cpSync,
  existsSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(process.cwd(), 'tools', 'pipeline', 'commitback.sh')

// execFileSync's default stdio sends the child's stderr straight to this
// process' stderr (only stdout is piped/captured by default) — git's routine
// "To ...", "From ...", "* [new branch] ..." progress chatter on every clone/
// push/fetch would otherwise leak into the test runner's TAP output. Pipe
// stderr too so it is captured (and available on the error object) instead
// of inherited.
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// A bare "origin", a clone that plays the human, and a clone that plays the
// runner. Mirrors the real topology: both push to the same master.
function scaffold() {
  const root = mkdtempSync(join(tmpdir(), 'commitback-'))
  const origin = join(root, 'origin.git')
  mkdirSync(origin)
  git(origin, 'init', '--bare', '--initial-branch=master')

  const seed = join(root, 'seed')
  git(root, 'clone', origin, 'seed')
  git(seed, 'config', 'user.name', 'seed')
  git(seed, 'config', 'user.email', 'seed@example.com')
  mkdirSync(join(seed, 'data'))
  mkdirSync(join(seed, 'assets', 'img', 'wines'), { recursive: true })
  // Git does not track empty directories. In the real repo assets/img/wines
  // always has committed bottle images; seed a placeholder so this directory
  // survives the clone the same way, otherwise `git add assets/img/wines`
  // fails with "pathspec did not match any files" in every clone.
  writeFileSync(join(seed, 'assets', 'img', 'wines', '.placeholder'), 'seed\n')
  // A committed bottle photograph, so a test can play out the case that breaks
  // the real pipeline: enrich withdraws a photo (writeImageFile deletes the
  // sibling .jpg whenever it writes an .svg) while a human edits it.
  writeFileSync(join(seed, 'assets', 'img', 'wines', 'photo.jpg'), 'seed photo\n')
  writeFileSync(join(seed, 'data', 'wines.json'), JSON.stringify([{ sku: '1', imagePath: 'a.svg' }]))
  writeFileSync(join(seed, 'data', 'hot-sellers.json'), JSON.stringify({ skus: ['1'] }))
  writeFileSync(join(seed, '.bunny-manifest.json'), JSON.stringify({}))
  writeFileSync(join(seed, 'README.md'), 'seed version\n')
  // The real repo tracks a path with spaces in it. Kept here so the conflict
  // loop is exercised against one.
  writeFileSync(join(seed, 'Fine Vines Website (standalone).html'), 'seed standalone\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '-m', 'seed')
  git(seed, 'push', 'origin', 'master')

  const runner = join(root, 'runner')
  git(root, 'clone', origin, 'runner')
  cpSync(SCRIPT, join(runner, 'commitback.sh'))

  const human = join(root, 'human')
  git(root, 'clone', origin, 'human')
  git(human, 'config', 'user.name', 'human')
  git(human, 'config', 'user.email', 'human@example.com')

  return { root, origin, runner, human }
}

function runCommitback(cwd) {
  return execFileSync('bash', ['commitback.sh'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PIPELINE_BOT_NAME: 'bot', PIPELINE_BOT_EMAIL: 'bot@example.com' },
  })
}

// execFileSync's thrown Error.message carries only stderr — the script's own
// diagnostics are plain `echo` (stdout). Run it expecting a non-zero exit and
// hand back stdout/status so a test can assert on what the script reported.
// stderr is piped (not inherited) for the same reason as git() above — the
// underlying git rebase/fetch chatter would otherwise leak into the TAP
// stream on every run of the abort test — but it is still captured on the
// error object, so this helper keeps returning it too.
function runCommitbackExpectingFailure(cwd) {
  try {
    execFileSync('bash', ['commitback.sh'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PIPELINE_BOT_NAME: 'bot', PIPELINE_BOT_EMAIL: 'bot@example.com' },
    })
    throw new Error('expected commitback.sh to exit non-zero, but it succeeded')
  } catch (e) {
    if (e.status === undefined || e.status === 0) throw e
    return { status: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

test('pushes the run state when master has not moved', (t) => {
  const { root, runner, origin } = scaffold()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writeFileSync(join(runner, 'data', 'wines.json'), JSON.stringify([{ sku: '1', imagePath: 'a.jpg' }]))
  runCommitback(runner)

  const head = git(origin, 'show', 'master:data/wines.json')
  assert.match(head, /a\.jpg/)
})

test('bot wins on data/ when a human pushed a conflicting change mid-run', (t) => {
  const { root, runner, human, origin } = scaffold()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  // The human edits the same file and pushes first — the 2026-08-04 failure.
  writeFileSync(join(human, 'data', 'wines.json'), JSON.stringify([{ sku: '1', imagePath: 'human.jpg' }]))
  writeFileSync(join(human, 'data', 'hot-sellers.json'), JSON.stringify({ skus: ['1', '2'] }))
  git(human, 'add', 'data')
  git(human, 'commit', '-m', 'human edit')
  git(human, 'push', 'origin', 'master')

  // The runner has its own version of both files.
  writeFileSync(join(runner, 'data', 'wines.json'), JSON.stringify([{ sku: '1', imagePath: 'bot.jpg' }]))
  writeFileSync(join(runner, 'data', 'hot-sellers.json'), JSON.stringify({ skus: ['9'] }))
  runCommitback(runner)

  assert.match(git(origin, 'show', 'master:data/wines.json'), /bot\.jpg/)
  assert.match(git(origin, 'show', 'master:data/hot-sellers.json'), /"9"/)
  // The human's commit is still in history — only the file content lost.
  assert.match(git(origin, 'log', '--format=%s'), /human edit/)
})

test('the merged wines.json still parses as JSON', (t) => {
  const { root, runner, human } = scaffold()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writeFileSync(join(human, 'data', 'wines.json'), JSON.stringify([{ sku: '1', imagePath: 'human.jpg' }]))
  git(human, 'add', 'data')
  git(human, 'commit', '-m', 'human edit')
  git(human, 'push', 'origin', 'master')

  writeFileSync(join(runner, 'data', 'wines.json'), JSON.stringify([{ sku: '1', imagePath: 'bot.jpg' }]))
  const out = runCommitback(runner)

  assert.match(out, /wines\.json parses/)
})

test('the narrow pathspec keeps a concurrent README edit out of the commit', (t) => {
  const { root, runner, human } = scaffold()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writeFileSync(join(human, 'README.md'), 'human version\n')
  git(human, 'add', 'README.md')
  git(human, 'commit', '-m', 'human readme')
  git(human, 'push', 'origin', 'master')

  writeFileSync(join(runner, 'data', 'wines.json'), JSON.stringify([{ sku: '1', imagePath: 'bot.jpg' }]))
  // README is not in the bot's pathspec, so `git add` never stages it and the
  // rebase never even looks at it. This asserts the pathspec limit holds: the
  // push succeeds and the human's concurrent README edit survives untouched.
  runCommitback(runner)
  assert.equal(git(runner, 'show', 'origin/master:README.md'), 'human version\n')
})

test('a conflict outside bot-owned paths aborts instead of overwriting', (t) => {
  const { root, runner, human } = scaffold()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  // The human's README edit is committed on master BEFORE commitback runs, so
  // when the runner later commits its own conflicting README edit and rebases,
  // the replay actually collides on README.md — unlike the pathspec test
  // above, where README is never staged by the script at all.
  writeFileSync(join(human, 'README.md'), 'human version\n')
  git(human, 'add', 'README.md')
  git(human, 'commit', '-m', 'human readme')
  git(human, 'push', 'origin', 'master')

  // The runner commits its own conflicting README change directly (bypassing
  // the script's own pathspec-limited `git add`) so that when commitback.sh
  // rebases onto origin/master, this commit is replayed too and collides.
  writeFileSync(join(runner, 'README.md'), 'bot version\n')
  git(runner, 'add', 'README.md')
  git(runner, 'commit', '-m', 'runner readme')

  writeFileSync(join(runner, 'data', 'wines.json'), JSON.stringify([{ sku: '1', imagePath: 'bot.jpg' }]))

  const { status, stdout } = runCommitbackExpectingFailure(runner)

  assert.notEqual(status, 0)
  assert.match(stdout, /CONFLICT IN A PATH THE PIPELINE DOES NOT OWN: README\.md/)
  assert.equal(existsSync(join(runner, '.git', 'rebase-merge')), false)
  assert.equal(existsSync(join(runner, '.git', 'rebase-apply')), false)
})

test('the bot withdrawing a photo a human edited resolves as a deletion', (t) => {
  const { root, runner, human, origin } = scaffold()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  // The human touches up a bottle photograph and pushes.
  writeFileSync(join(human, 'assets', 'img', 'wines', 'photo.jpg'), 'human retouch\n')
  git(human, 'add', 'assets/img/wines/photo.jpg')
  git(human, 'commit', '-m', 'human retouches a photo')
  git(human, 'push', 'origin', 'master')

  // The run withdrew that photo — internal/enrich.writeImageFile deletes the
  // sibling .jpg whenever it falls back to an SVG label. 551 photos went that
  // way in a single pass on 2026-08-06, so this is not hypothetical.
  rmSync(join(runner, 'assets', 'img', 'wines', 'photo.jpg'))
  writeFileSync(join(runner, 'data', 'wines.json'), JSON.stringify([{ sku: '1', imagePath: 'a.svg' }]))

  const out = runCommitback(runner)

  // Modify/delete has no stage 3, so `git checkout --theirs` cannot be what
  // resolves it. The bot still wins, and the bot's version is "gone".
  assert.match(out, /photo\.jpg/)
  assert.equal(existsSync(join(runner, '.git', 'rebase-merge')), false)
  assert.equal(existsSync(join(runner, '.git', 'rebase-apply')), false)
  const tracked = git(origin, 'ls-tree', '-r', '--name-only', 'master')
  assert.equal(tracked.includes('assets/img/wines/photo.jpg'), false)
})

test('the human deleting a photo the bot rewrote still resolves in the bot’s favour', (t) => {
  const { root, runner, human, origin } = scaffold()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  // The mirror image of the case above. This direction DOES have a stage 3
  // (the replayed bot commit), so plain --theirs handles it — asserted here so
  // the fix for the other direction cannot quietly regress it.
  git(human, 'rm', '--quiet', 'assets/img/wines/photo.jpg')
  git(human, 'commit', '-m', 'human drops a photo')
  git(human, 'push', 'origin', 'master')

  writeFileSync(join(runner, 'assets', 'img', 'wines', 'photo.jpg'), 'bot photo\n')
  writeFileSync(join(runner, 'data', 'wines.json'), JSON.stringify([{ sku: '1', imagePath: 'photo.jpg' }]))

  runCommitback(runner)

  assert.equal(git(origin, 'show', 'master:assets/img/wines/photo.jpg'), 'bot photo\n')
})

test('a rebase that failed for a reason other than a conflict says so', (t) => {
  const { root, runner, human } = scaffold()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writeFileSync(join(human, 'data', 'wines.json'), JSON.stringify([{ sku: '1', imagePath: 'human.jpg' }]))
  git(human, 'add', 'data')
  git(human, 'commit', '-m', 'human edit')
  git(human, 'push', 'origin', 'master')

  writeFileSync(join(runner, 'data', 'wines.json'), JSON.stringify([{ sku: '1', imagePath: 'bot.jpg' }]))
  // A tracked file outside the bot's pathspec is dirty, so `git rebase`
  // refuses before it starts. Nothing is conflicted and no rebase is in
  // progress — reporting this as "conflicts" sends the 2am operator hunting
  // for a merge that never happened.
  writeFileSync(join(runner, 'README.md'), 'locally scribbled\n')

  const { status, stdout } = runCommitbackExpectingFailure(runner)

  assert.notEqual(status, 0)
  assert.doesNotMatch(stdout, /rebase hit conflicts/)
  assert.match(stdout, /nothing is conflicted/)
})

test('a conflicting path with spaces is reported whole, not word-split', (t) => {
  const { root, runner, human } = scaffold()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const spaced = 'Fine Vines Website (standalone).html'
  writeFileSync(join(human, spaced), 'human standalone\n')
  git(human, 'add', spaced)
  git(human, 'commit', '-m', 'human standalone')
  git(human, 'push', 'origin', 'master')

  writeFileSync(join(runner, spaced), 'bot standalone\n')
  git(runner, 'add', spaced)
  git(runner, 'commit', '-m', 'runner standalone')
  writeFileSync(join(runner, 'data', 'wines.json'), JSON.stringify([{ sku: '1', imagePath: 'bot.jpg' }]))

  const { status, stdout } = runCommitbackExpectingFailure(runner)

  assert.notEqual(status, 0)
  assert.match(stdout, /CONFLICT IN A PATH THE PIPELINE DOES NOT OWN: Fine Vines Website \(standalone\)\.html/)
  assert.equal(existsSync(join(runner, '.git', 'rebase-merge')), false)
})

test('a rejected push is retried once', (t) => {
  const { root, runner, origin } = scaffold()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  // Reject exactly one push, then accept. Stands in for the small-but-real
  // window between our fetch and our push, which the inline block this script
  // replaced used to survive by retrying.
  const hook = join(origin, 'hooks', 'pre-receive')
  writeFileSync(
    hook,
    '#!/bin/sh\nif [ -f ./rejected-once ]; then exit 0; fi\ntouch ./rejected-once\nexit 1\n',
  )
  chmodSync(hook, 0o755)

  writeFileSync(join(runner, 'data', 'wines.json'), JSON.stringify([{ sku: '1', imagePath: 'retry.jpg' }]))
  runCommitback(runner)

  assert.match(git(origin, 'show', 'master:data/wines.json'), /retry\.jpg/)
})

test('nothing to commit is a success, not a failure', (t) => {
  const { root, runner } = scaffold()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const out = runCommitback(runner)
  assert.match(out, /nothing changed this run/)
})
