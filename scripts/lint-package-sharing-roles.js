#!/usr/bin/env node
/**
 * lint-package-sharing-roles — no sharing rule a package ships names a role, and every package states
 * the platform level its rules need.
 *
 *   node ./scripts/lint-package-sharing-roles.js                         # report
 *   node ./scripts/lint-package-sharing-roles.js --gate                  # exit 1 on a finding
 *   node ./scripts/lint-package-sharing-roles.js --json
 *   node ./scripts/lint-package-sharing-roles.js --gate --package DIR    # that package folder alone (repeatable)
 *
 * WHY THIS GATE EXISTS
 *
 * A sharing rule's user filter decides whom the rule applies to. Written as a list of role NAMES
 * (`user.roles in [...]`, `role nin ['owner', 'admin']`), it lets through a role merely named like a
 * built-in one and keeps out a custom role the deck gave the same permission. Everywhere else the deck
 * decides by permission (§9.167), so a rule that decides by name disagrees with the screens beside it, and
 * a deck's administrator cannot correct it: they can grant permissions to roles, not edit a package's
 * rules. RestroIn shipped nine such rules and the clinic and PharmaIn packages seven more before this gate.
 *
 * The sharing user carries what a rule needs instead:
 *   - `holds` — the permission keys the deck's rules name that the caller holds, matched by the platform's
 *     one permission matcher: `{ "field": "holds", "op": "in", "value": ["SettleBill:run"] }`;
 *   - `allScopes` — whether the caller may work in every scope (`records:all_scopes`, which `*:*`
 *     satisfies): `{ "field": "allScopes", "op": "ne", "value": true }` leaves deck-wide reach out.
 *
 * What it refuses: a user-filter condition on `role` or `roles` (with or without `user.`), and a
 * condition anywhere in a rule that reads the caller's role through `valueFrom`. A RECORD field called
 * `role` in a record filter is a column of the record, not the caller, and passes.
 *
 * THE PLATFORM LEVEL
 *
 * A sharing-user field the platform added later (`allScopes`, `holds`) is absent on a backend from
 * before it, and a rule that reads an absent field runs wrong instead of failing: an own-outlet rule
 * keyed on `allScopes` then applies to the owner too. libs/shared-types/src/platform-level.json lists
 * the level that added each field. A package whose rules read one, through a user-filter field or a
 * `valueFrom` in either filter, must state that level or a later one in package.json
 * (`"requires": { "platform": 2 }`), so that an older backend refuses the package. A stated level that
 * is not a whole number of at least 1, or is above the newest level, is a finding as well.
 *
 * Reads `sharing-rules/*.json` and the manifest's `sharingRules`: in the sibling repos
 * (../xdeck-packages/xdeck-pkg-*) and the package cache (var/package-cache/<ns>/<name>/<version>), or
 * only in the folders given to --package. A folder reached twice (a cache entry links to its sibling) is
 * read once.
 *
 * Exit codes: 0 clean (or findings without --gate) · 1 findings with --gate · 2 broken run (nothing to
 * read, an unreadable manifest or rule, a --package folder that is not there, --package with no folder,
 * or a platform level list it cannot read).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SIBLINGS_DIR = path.resolve(REPO_ROOT, '..', 'xdeck-packages');
const CACHE_DIR = path.join(REPO_ROOT, 'var', 'package-cache');

/** The caller's role, as a rule can name it: the engine strips one leading `user.`. */
const ROLE_PATH = /^(user\.)?roles?$/;

const FIX_HINT =
  '  Name the permission instead — { "field": "holds", "op": "in", "value": ["<Resource>:<action>"] } —\n' +
  '  or leave deck-wide reach out with { "field": "allScopes", "op": "ne", "value": true }.\n' +
  '  See docs/guides/package-dev-build-release.md, "Sharing rules decide by permission".\n';

const PLATFORM_HINT =
  '  State the lowest platform level the package runs on in package.json: "requires": { "platform": <level> }.\n' +
  '  The levels are in libs/shared-types/src/platform-level.json. See docs/guides/package-dev-build-release.md,\n' +
  '  "The platform level a package needs".\n';

/** Every condition of a filter, nested groups included. */
function conditionsOf(filter) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const c of Array.isArray(node.conditions) ? node.conditions : []) {
      if (c && typeof c === 'object') out.push(c);
    }
    if (node.group) walk(node.group);
    for (const g of Array.isArray(node.groups) ? node.groups : []) walk(g);
  };
  walk(filter);
  return out;
}

/** What is wrong with one rule, as sentences; [] when nothing is. */
function ruleFindings(rule) {
  if (!rule || typeof rule !== 'object') return [];
  const out = [];
  for (const c of conditionsOf(rule.userFilter)) {
    if (ROLE_PATH.test(String(c.field ?? ''))) out.push(`its user filter names a role (\`${c.field}\`)`);
  }
  for (const c of [...conditionsOf(rule.userFilter), ...conditionsOf(rule.recordFilter)]) {
    if (ROLE_PATH.test(String(c.valueFrom ?? ''))) {
      out.push(`it reads the caller's role through valueFrom (\`${c.valueFrom}\`)`);
    }
  }
  return out;
}

/**
 * The platform levels: the newest, and the level that added each sharing-user field. `file` is for
 * tests; without it the lint reads the monorepo's list through a relative require, so the release
 * host's vendor check sees that the lint needs it. Throws when the list cannot be read or is malformed.
 */
function loadPlatformLevels(file) {
  const list =
    file === undefined
      ? require('../libs/shared-types/src/platform-level.json')
      : JSON.parse(fs.readFileSync(file, 'utf8'));
  const levels = list && Array.isArray(list.levels) ? list.levels : [];
  if (levels.length === 0) throw new Error('it lists no level');
  const fieldLevel = new Map();
  levels.forEach((l, i) => {
    if (!l || l.level !== i + 1) throw new Error(`entry ${i + 1} is not level ${i + 1}`);
    if (!Array.isArray(l.sharingUserFields)) throw new Error(`level ${i + 1} has no sharingUserFields list`);
    for (const f of l.sharingUserFields) if (!fieldLevel.has(f)) fieldLevel.set(f, l.level);
  });
  return { current: levels.length, fieldLevel };
}

/** The sharing-user fields a rule reads: its user filter's fields and every valueFrom, `user.` taken off. */
function userFieldsOf(rule) {
  if (!rule || typeof rule !== 'object') return [];
  const bare = (s) => String(s).replace(/^user\./, '');
  const out = [];
  for (const c of conditionsOf(rule.userFilter)) if (c.field !== undefined) out.push(bare(c.field));
  for (const c of [...conditionsOf(rule.userFilter), ...conditionsOf(rule.recordFilter)]) {
    if (c.valueFrom !== undefined) out.push(bare(c.valueFrom));
  }
  return out;
}

/** What is wrong with the platform level a package states, given the rules it ships; [] when nothing is. */
function platformFindings(label, manifest, rules, { current, fieldLevel }) {
  const at = { kind: 'platform', package: label, source: 'package.json requires.platform' };
  const requires = manifest && manifest.requires && typeof manifest.requires === 'object' ? manifest.requires : {};
  const stated = requires.platform;
  if (stated !== undefined && !(Number.isInteger(stated) && stated >= 1)) {
    return [{ ...at, rule: null, why: `it must be a whole number of at least 1, not ${JSON.stringify(stated)}` }];
  }
  const have = stated === undefined ? 1 : stated;
  let need = { level: 1, field: null, rule: null };
  for (const { rule } of rules) {
    for (const field of userFieldsOf(rule)) {
      const level = fieldLevel.get(field) || 1;
      if (level > need.level) need = { level, field, rule: typeof rule.name === 'string' ? rule.name : null };
    }
  }
  const out = [];
  if (need.level > have) {
    const says = stated === undefined ? 'states no level (so level 1)' : `states level ${stated}`;
    out.push({
      ...at,
      rule: need.rule,
      why: `its sharing rules read \`${need.field}\`, which platform level ${need.level} added, and it ${says}`
    });
  }
  if (have > current) {
    out.push({ ...at, rule: null, why: `it states level ${have}, and the newest platform level is ${current}` });
  }
  return out;
}

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const subdirs = (p) =>
  isDir(p)
    ? fs
        .readdirSync(p)
        .filter((n) => isDir(path.join(p, n)))
        .sort()
    : [];

/**
 * The folders named by `--package DIR` or `--package=DIR`, in order — `[]` when none was given,
 * `null` when a `--package` has no folder after it.
 */
function packageArgs(argv) {
  const dirs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--package') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) return null;
      dirs.push(next);
      i++;
    } else if (String(argv[i]).startsWith('--package=')) {
      const dir = argv[i].slice('--package='.length);
      if (!dir) return null;
      dirs.push(dir);
    }
  }
  return dirs;
}

/** The package folders to read, `{ dir, label }`, each real folder once. */
function packageDirs({ only, siblingsDir, cacheDir }) {
  const found = [];
  const seen = new Set();
  const add = (dir, label) => {
    let real = dir;
    try {
      real = fs.realpathSync(dir);
    } catch {
      // Not there: kept, so reading it reports it as unread.
    }
    if (seen.has(real)) return;
    seen.add(real);
    found.push({ dir, label });
  };
  if (only.length > 0) {
    for (const d of only) add(path.resolve(d), d);
    return found;
  }
  for (const n of subdirs(siblingsDir)) {
    if (n.startsWith('xdeck-pkg-') && fs.existsSync(path.join(siblingsDir, n, 'package.json'))) {
      add(path.join(siblingsDir, n), n);
    }
  }
  for (const ns of subdirs(cacheDir)) {
    for (const name of subdirs(path.join(cacheDir, ns))) {
      for (const v of subdirs(path.join(cacheDir, ns, name)))
        add(path.join(cacheDir, ns, name, v), `${ns}/${name}@${v}`);
    }
  }
  return found;
}

/**
 * One package folder: how many rules it ships, what is wrong with them (a role named, a platform level
 * not stated) and what could not be read. Without `levels` (loadPlatformLevels()) no level is checked.
 */
function readPackage({ dir, label }, levels = null) {
  const res = { label, rules: 0, findings: [], unread: [] };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch (err) {
    res.unread.push(`${label}: package.json (${err.code || err.message})`);
    return res;
  }
  const rules = [];
  if (manifest.sharingRules !== undefined && !Array.isArray(manifest.sharingRules)) {
    res.unread.push(`${label}: package.json sharingRules is not a list`);
  }
  (Array.isArray(manifest.sharingRules) ? manifest.sharingRules : []).forEach((rule, i) =>
    rules.push({ rule, source: `package.json sharingRules[${i}]` })
  );
  const rulesDir = path.join(dir, 'sharing-rules');
  if (isDir(rulesDir)) {
    for (const f of fs
      .readdirSync(rulesDir)
      .filter((n) => n.endsWith('.json'))
      .sort()) {
      try {
        rules.push({ rule: JSON.parse(fs.readFileSync(path.join(rulesDir, f), 'utf8')), source: `sharing-rules/${f}` });
      } catch (err) {
        res.unread.push(`${label}: sharing-rules/${f} (${err.message})`);
      }
    }
  }
  res.rules = rules.length;
  for (const { rule, source } of rules) {
    for (const why of ruleFindings(rule)) {
      res.findings.push({
        kind: 'role',
        package: label,
        source,
        rule: rule && typeof rule.name === 'string' ? rule.name : null,
        why
      });
    }
  }
  if (levels) res.findings.push(...platformFindings(label, manifest, rules, levels));
  return res;
}

/** Runs the lint and returns the exit status. */
function main(
  argv,
  { siblingsDir = SIBLINGS_DIR, cacheDir = CACHE_DIR, levelFile, out = process.stdout, err = process.stderr } = {}
) {
  const gate = argv.includes('--gate');
  const json = argv.includes('--json');
  const only = packageArgs(argv);
  if (only === null) {
    err.write('lint-package-sharing-roles: --package needs a folder: --package DIR\n');
    return 2;
  }
  let levels;
  try {
    levels = loadPlatformLevels(levelFile);
  } catch (e) {
    const why = e.code === 'MODULE_NOT_FOUND' || e.code === 'ENOENT' ? 'the file is not there' : e.message;
    err.write(
      `lint-package-sharing-roles: COULD NOT READ the platform level list (${levelFile || 'libs/shared-types/src/platform-level.json'}): ${why}\n`
    );
    return 2;
  }
  const dirs = packageDirs({ only, siblingsDir, cacheDir });
  const results = dirs.map((d) => readPackage(d, levels));
  const findings = results.flatMap((r) => r.findings);
  const unread = results.flatMap((r) => r.unread);
  const rules = results.reduce((n, r) => n + r.rules, 0);
  if (json) {
    out.write(
      JSON.stringify({ packages: dirs.length, rules, platformLevel: levels.current, findings, unread }, null, 2) + '\n'
    );
  } else {
    for (const f of findings) out.write(`  ✗ ${f.package} ${f.source}${f.rule ? ` (${f.rule})` : ''}: ${f.why}\n`);
    if (findings.some((f) => f.kind === 'role')) out.write(FIX_HINT);
    if (findings.some((f) => f.kind === 'platform')) out.write(PLATFORM_HINT);
    for (const u of unread) out.write(`  ? could not read ${u}\n`);
    out.write(
      `[lint-sharing-roles] ${dirs.length} package(s), ${rules} sharing rule(s), ${findings.length} finding(s)\n`
    );
    if (dirs.length === 0) {
      out.write(
        '[lint-sharing-roles] COULD NOT READ what it polices — no package folder found ' +
          '(../xdeck-packages, var/package-cache, or --package).\n'
      );
    }
  }
  if (dirs.length === 0 || unread.length > 0) return 2;
  if (gate && findings.length > 0) return 1;
  return 0;
}

module.exports = {
  main,
  ruleFindings,
  conditionsOf,
  packageArgs,
  packageDirs,
  readPackage,
  loadPlatformLevels,
  userFieldsOf,
  platformFindings
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
