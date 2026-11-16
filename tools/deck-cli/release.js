#!/usr/bin/env node
/**
 * tools/deck-cli/release.js — cut a release tag from `master` for a deck. The platform's one copy:
 * a deck repository carries no tooling of its own, and a person runs this from a clone of the
 * platform (`npm run deck:release -- --deck DIR`) or of the public release host.
 *
 * The deck is `--deck DIR` (default: the current directory), and every git command runs there. Its
 * slug is config.json's `subdomain`, or the folder's name when config.json names none (deck-dir.js).
 *
 * Tag format (per §9.46.3):
 *   Transitional            <slug>/vX.Y.Z         e.g. acme/v1.2.3
 *   Target (per-deck repo)  vX.Y.Z                e.g. v1.2.3
 *
 * Tags are ALWAYS cut from `master` — the branch-per-env model means
 * non-prod env state lives on env branches (`dev1..N`, `sit`, `uat`),
 * not in tags. Pre-release tags (`-rc.N` / `-beta.N`) are NOT used for
 * decks — the env ladder serves the staged-rollout purpose. See
 * docs/development/gitflow-tenants.md.
 *
 * What this script does:
 *   1. Asserts the deck's current branch is `master` and its working tree is clean.
 *   2. Runs validate.js against the deck.
 *   3. Computes target version (`--version` > `--bump` > current).
 *   4. Refuses to clobber an existing tag (local or origin) — tags are
 *      immutable. Redeploying the same release is a UI action on the
 *      already-registered tag.
 *   5. Creates an annotated <slug>/vX.Y.Z tag in the deck's repository and pushes.
 *   6. Tag push triggers the deck's validate-on-tag.yml, which validates
 *      the tag and registers it in xDeck's release registry.
 *      It does NOT deploy. Deploy is a UI action at app.xdeck.in
 *      (per §9.46.5).
 *
 * Removed flags (per §9.46 slice 3):
 *   --env      env routing now happens at the branch / UI level, not in
 *              tags. Lower envs auto-deploy on PR-merge to dev1..N / sit /
 *              uat via branch-deploy.yml; prod deploys via UI.
 *   --replay   rollback / re-deploy is now a UI action (§9.46.5) — the
 *              deck owner deploys an earlier registered tag through
 *              the Releases page. deploy-replay.yml no longer exists.
 *
 * Usage:
 *   node tools/deck-cli/release.js [--deck DIR]
 *                                  [--version vX.Y.Z]
 *                                  [--bump major|minor|patch]
 *                                  [--message "..."]
 *                                  [--dry-run] [--no-push]
 *
 * Required tooling:
 *   - git push access to the deck repository's remote `origin`
 *
 * Cross-platform: Node-only. Spawns git via child_process.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { SLUG_RE, deckDir, deckSlug } = require('./deck-dir');

// Set once from --deck in main(), before anything reads them.
let TENANT_DIR = '';
let SLUG = '';

const SEMVER_RE = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
const RELEASE_BRANCH = 'master';

function die(msg, code = 1) {
  process.stderr.write(`❌ ${msg}\n`);
  process.exit(code);
}

function usage() {
  process.stdout.write(`tools/deck-cli/release.js — cut a release tag from \`${RELEASE_BRANCH}\` for a deck.

USAGE
  node tools/deck-cli/release.js [--deck DIR]          # DIR defaults to the current directory
                                 [--version vX.Y.Z]
                                 [--bump major|minor|patch]
                                 [--message "..."]
                                 [--dry-run] [--no-push]
  npm run deck:release -- --deck DIR ...               # the same, from the platform repo

EXAMPLES
  node tools/deck-cli/release.js --deck ../my-deck --version v1.0.0
  node tools/deck-cli/release.js --deck ../my-deck --bump minor          # auto-bump from latest tag
  node tools/deck-cli/release.js --deck ../my-deck --bump patch --dry-run

NOTES
  - The slug is config.json's subdomain (else the folder's name).
  - Tag format: <slug>/vX.Y.Z (transitional) → vX.Y.Z (post §9.43).
  - Tags are cut from \`${RELEASE_BRANCH}\` only. Non-prod envs deploy via
    PR-merge to dev*/sit/uat branches — see gitflow-tenants.md.
  - Tag push triggers validate-on-tag.yml (validate + register). Deploy
    is a separate UI action at app.xdeck.in (per §9.46.5).
  - Rollback / replay: deploy an earlier registered tag through the UI.
    The --replay flag has been removed.
`);
}

function parseArgs(argv) {
  const opts = {
    deck: undefined,
    version: '',
    bump: 'patch',
    message: '',
    dryRun: false,
    noPush: false
  };

  // Reject removed flags with a helpful migration message.
  if (argv.includes('--env')) {
    die(
      `--env was removed under §9.46 slice 3. Tags are cut from master only; ` +
        `env routing happens at the branch / UI level. ` +
        `See docs/development/gitflow-tenants.md.`,
      1
    );
  }
  if (argv.includes('--replay')) {
    die(
      `--replay was removed under §9.46 slice 3. Rollback / re-deploy is now ` +
        `a UI action — open app.xdeck.in → Tenant → Releases and deploy the ` +
        `prior tag. See §9.46.5.`,
      1
    );
  }

  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) die(`${a} requires a value`, 1);
      return argv[++i];
    };
    switch (a) {
      case '--deck':
        opts.deck = next();
        break;
      case '--version':
        opts.version = next();
        break;
      case '--bump':
        opts.bump = next();
        break;
      case '--message':
      case '-m':
        opts.message = next();
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--no-push':
        opts.noPush = true;
        break;
      case '-h':
      case '--help':
        usage();
        process.exit(0);
        break;
      default:
        die(`Unknown argument: ${a} (run with --help)`, 1);
    }
    i++;
  }
  return opts;
}

/** git, always in the deck's repository — never in the directory this was started from. */
function git(args, opts = {}) {
  return spawnSync('git', args, {
    stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    ...opts,
    cwd: TENANT_DIR
  });
}

function tagExistsLocal(tag) {
  return git(['rev-parse', tag]).status === 0;
}
function tagExistsRemote(tag) {
  const result = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]);
  return result.status === 0 && result.stdout.includes(tag);
}
function listTagsMatching(prefix) {
  const result = git(['tag', '--list', `${prefix}/v*.*.*`]);
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function semverCompare(a, b) {
  // Strip prefix (`<slug>/v` or `v`) before comparing.
  const aP = a.replace(/^.*v/, '').split('.').slice(0, 3).map(Number);
  const bP = b.replace(/^.*v/, '').split('.').slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if (aP[i] !== bP[i]) return aP[i] - bP[i];
  return 0;
}

function bumpVersion(latest, kind) {
  // Strip everything before the version (handles both `<slug>/vX.Y.Z` and `vX.Y.Z`).
  const stripped = latest.replace(/^.*v/, '');
  const [maj, min, pat] = stripped.split('.').map(Number);
  if (kind === 'major') return `v${maj + 1}.0.0`;
  if (kind === 'minor') return `v${maj}.${min + 1}.0`;
  return `v${maj}.${min}.${pat + 1}`;
}

function assertOnReleaseBranch() {
  const branchResult = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = (branchResult.stdout || '').trim();
  if (branch !== RELEASE_BRANCH) {
    die(
      `Release tags must be cut from \`${RELEASE_BRANCH}\` — current branch is \`${branch}\`.\n` +
        `   Promote the change up the branch ladder (devN → sit → uat → ${RELEASE_BRANCH}) before tagging.\n` +
        `   See docs/development/gitflow-tenants.md for the promotion flow.`,
      1
    );
  }
}

function assertCleanTree() {
  const result = git(['status', '--porcelain']);
  if (result.status !== 0) die(`git status failed`, result.status || 1);
  if ((result.stdout || '').trim() !== '') {
    die(`Working tree is not clean. Commit or revert your changes before cutting a tag.`, 1);
  }
}

function cut(opts) {
  if (!SLUG_RE.test(SLUG)) die(`Invalid slug: ${SLUG} (lowercase alphanumeric + hyphens, 1-50 chars)`, 1);
  if (!fs.existsSync(TENANT_DIR)) die(`tenant folder vanished: ${TENANT_DIR}`, 1);
  if (!['major', 'minor', 'patch'].includes(opts.bump))
    die(`Invalid --bump: ${opts.bump} (expected major|minor|patch)`, 1);

  // Branch + cleanliness gates — release tags are master-only by design.
  assertOnReleaseBranch();
  assertCleanTree();

  // Pre-tag validation — never cut a tag pointing at broken config.
  process.stdout.write(`🔍 Validating tenant config before tagging...\n`);
  const validate = spawnSync(process.execPath, [path.join(__dirname, 'validate.js'), '--deck', TENANT_DIR], {
    stdio: 'inherit'
  });
  if (validate.status !== 0) die(`validate.js failed for ${SLUG}`, validate.status || 1);
  process.stdout.write('\n');

  let version = opts.version;
  if (version) {
    if (!SEMVER_RE.test(version)) die(`Invalid --version: ${version} (expected vX.Y.Z)`, 1);
  } else {
    git(['fetch', '--tags', '--quiet', 'origin']);
    const tags = listTagsMatching(SLUG).sort(semverCompare);
    const latest = tags[tags.length - 1] || '';
    if (!latest) {
      version = 'v1.0.0';
      process.stdout.write(`ℹ️  No existing ${SLUG}/* tag — starting at ${version}\n`);
    } else {
      version = bumpVersion(latest, opts.bump);
      process.stdout.write(`ℹ️  Latest ${SLUG}/* is ${latest} → bumping ${opts.bump} → ${version}\n`);
    }
  }

  const tag = `${SLUG}/${version}`;

  if (tagExistsLocal(tag))
    die(
      `Tag already exists locally: ${tag}\n   Pick a new --version. Tags are immutable; redeploying is a UI action on the registered tag.`,
      1
    );
  if (tagExistsRemote(tag))
    die(
      `Tag already exists on origin: ${tag}\n   Pick a new --version. Tags are immutable; redeploying is a UI action on the registered tag.`,
      1
    );

  const message = opts.message || `release: ${tag}`;
  const head = git(['rev-parse', 'HEAD']);
  const commitSha = (head.stdout || '').trim();

  process.stdout.write('\n');
  process.stdout.write(`📦 Release plan\n`);
  process.stdout.write(`   slug     : ${SLUG}\n`);
  process.stdout.write(`   version  : ${version}\n`);
  process.stdout.write(`   tag      : ${tag}\n`);
  process.stdout.write(`   from     : ${RELEASE_BRANCH} @ ${commitSha.slice(0, 12)}\n`);
  process.stdout.write(`   message  : ${message}\n`);
  process.stdout.write(`   dry-run  : ${opts.dryRun}\n`);
  process.stdout.write(`   push     : ${opts.noPush ? 'no' : 'yes'}\n\n`);

  if (opts.dryRun) {
    process.stdout.write(`✅ Dry run — no tag created, no push.\n`);
    return;
  }

  const tagResult = git(['tag', '-a', tag, '-m', message], { stdio: 'inherit' });
  if (tagResult.status !== 0) die(`git tag failed`, tagResult.status || 1);
  process.stdout.write(`✅ Created tag ${tag}\n`);

  if (opts.noPush) {
    process.stdout.write(`\nℹ️  --no-push set — push manually when ready:\n   git push origin refs/tags/${tag}\n`);
    return;
  }
  const pushResult = git(['push', 'origin', `refs/tags/${tag}`], { stdio: 'inherit' });
  if (pushResult.status !== 0) die(`git push failed`, pushResult.status || 1);
  process.stdout.write(`\n🚀 Pushed ${tag}\n`);
  process.stdout.write(`   → the deck's .github/workflows/validate-on-tag.yml will validate + register this tag.\n`);
  process.stdout.write(`   → Deploy is a UI action at app.xdeck.in → Tenant → Releases.\n`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  TENANT_DIR = deckDir(opts.deck);
  SLUG = deckSlug(TENANT_DIR);
  cut(opts);
}

main();
