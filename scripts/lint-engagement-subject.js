#!/usr/bin/env node
/**
 * scripts/lint-engagement-subject.js
 *
 * §9.61 engagement-subject SECURITY INVARIANT gate.
 *
 * When a ClienX account-holder engages a tenant on behalf of someone else (a
 * family dependent), the record is ABOUT the subject, not the logged-in actor.
 * Tenant code must always be able to join on the SUBJECT — never only the
 * actor — or a father ends up reading his daughter's clinic notes. Missing the
 * subject in even one place is a privacy breach.
 *
 * This lint enforces the structural PRECONDITION of that invariant on tenant
 * entity definitions: any "engagement record" that references the consumer
 * ACTOR (`clienxUserId` / `actorUserId`) MUST also declare a SUBJECT field
 * (`subjectDependentId` / `subjectUserId` / `subjectId`), so the subject is
 * always available to join on. (The query-level check — "no `WHERE actor_*` on
 * a subject-bearing record" — runs as a heuristic over tenant class code below;
 * the structural gate is what makes that query-level join even possible.)
 *
 * Exemptions:
 *   - The subject-DEFINING entity itself (the family/dependent registry — it IS
 *     the subject; detected by a `relation` enum + `promotedUserId`, the §9.61
 *     Q5 shape) does not need a subject field.
 *   - An entity carrying an `engagement-subject-lint-ok` opt-out (in any column
 *     comment or the entity description) for reviewed exceptions.
 *
 * Usage:
 *   node scripts/lint-engagement-subject.js            # report (advisory, exit 0)
 *   node scripts/lint-engagement-subject.js --strict   # exit 1 on a new violation or on what it could not read
 *   node scripts/lint-engagement-subject.js --json
 *   node scripts/lint-engagement-subject.js --strict --package DIR   # that package folder alone (repeatable)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const TENANTS_DIR = path.join(REPO_ROOT, 'tenants');

/**
 * Violations that existed BEFORE this gate was repaired (2026-07-30), listed so
 * `--strict` keeps blocking anything NEW while these are triaged.
 *
 * **Why a grandfather list rather than a clean red.** Until 2026-07-30 this gate
 * scanned zero files — `tenants/<slug>/entities/definitions/` does not exist in
 * any deck working tree, and the records it polices had moved into the package
 * repos entirely. It ran `--strict` in `tenant-release.yml` describing itself as
 * a deploy-blocking privacy control, and blocked nothing. Repairing discovery
 * immediately surfaced the two entries below, which have therefore been shipping
 * for months. Turning every tenant release red today, with no warning and on
 * findings nobody has triaged, is a larger unilateral act than recording them —
 * so they are recorded, loudly and countably.
 *
 * **This list may only SHRINK.** Each entry needs one of two dispositions from
 * the package's owner, both of which remove it from here:
 *   1. add a subject column, or
 *   2. add the reviewed `engagement-subject-lint-ok` opt-out the gate already
 *      supports, if the record genuinely has no subject.
 *
 * Adding a new entry means shipping a privacy violation — do not.
 */
const GRANDFATHERED = Object.freeze([
  // restroin-core `OrderEvent` records who performed an action (`actorUserId`).
  // The subject is presumably the order's customer link — needs confirming.
  'restroin/restroin-core:entities/OrderEvent.entity.json'
]);

/**
 * True when a reported file is one of the pre-existing, tracked violations. An entry is
 * `<namespace>/<name>:<path inside the package>`: the package's own name, never the folder it
 * sits in. Until 2026-10-16 entries were matched against the end of the file's path, which held
 * only in a sibling repo named `xdeck-pkg-<name>`: a cached copy (`<namespace>/<name>/<version>/`)
 * or the release workflow's checkout (`pkg/`) turned the exempt record into a blocking one, and
 * any folder of that name anywhere was exempt.
 */
function isGrandfathered(entry) {
  return Boolean(entry.pkg) && GRANDFATHERED.includes(`${entry.pkg}:${entry.inner}`);
}

const ACTOR_COLS = ['clienxUserId', 'actorUserId'];
const SUBJECT_COLS = ['subjectDependentId', 'subjectUserId', 'subjectId'];
const OPT_OUT = 'engagement-subject-lint-ok';

/** Pure: given a parsed entity-DSL object, return any invariant violations. */
function lintEntity(entity) {
  const cols = entity && entity.columns ? entity.columns : {};
  const names = Array.isArray(cols) ? cols.map((c) => c && c.name).filter(Boolean) : Object.keys(cols);
  const has = (set) => names.some((n) => set.includes(n));

  // Opt-out: explicit reviewed exception in the description or any comment.
  const blob = JSON.stringify(entity || {});
  if (blob.includes(OPT_OUT)) return [];

  // Subject-defining registry (the §9.61 Q5 dependent entity) is itself the
  // subject — it carries `relation` + `promotedUserId` and needs no subject FK.
  const colVals = Array.isArray(cols) ? cols : Object.values(cols);
  const isSubjectRegistry =
    names.includes('promotedUserId') && colVals.some((c) => c && Array.isArray(c.enum) && c.enum.includes('child'));
  if (isSubjectRegistry) return [];

  const actorField = ACTOR_COLS.find((a) => names.includes(a));
  if (!actorField) return []; // not an actor-bearing engagement record

  if (has(SUBJECT_COLS)) return []; // subject is declared — invariant satisfiable

  return [
    {
      entity: entity.name || entity.tableName || '(unnamed)',
      actorField,
      message:
        `engagement record references the actor '${actorField}' but declares no subject field ` +
        `(${SUBJECT_COLS.join(' / ')}). The §9.61 engagement-subject invariant (join on the subject, ` +
        `never the actor) cannot be honored. Add a subject FK, or add an '${OPT_OUT}' note if reviewed.`
    }
  ];
}

/** Heuristic code-level scan: a tenant .ts query filtering on the actor with no subject in sight. */
function lintSource(src) {
  const violations = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.includes(OPT_OUT)) continue;
    // a where/filter/andWhere referencing the actor id…
    if (/\b(where|andWhere|filter|find\w*)\b[^\n]*\b(clienxUserId|actorUserId)\b/.test(raw)) {
      // …without a subject id anywhere on the same or adjacent line.
      const window = `${lines[i - 1] || ''}\n${raw}\n${lines[i + 1] || ''}`;
      if (!SUBJECT_COLS.some((s) => window.includes(s))) {
        violations.push({ line: i + 1, text: raw.trim().slice(0, 120) });
      }
    }
  }
  return violations;
}

const SIBLINGS_DIR = path.resolve(REPO_ROOT, '..', 'xdeck-packages');
const CACHE_DIR = path.join(REPO_ROOT, 'var', 'package-cache');
/** Never read inside a package: installed dependencies, build output, reports, history. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git']);
/** A package's server-side sources: the same two folders the deck working trees are read for. */
const SOURCE_DIRS = ['classes', 'triggers'];

/** The folders inside `dir`, links to folders included; hidden entries and files left out. */
function subdirs(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith('.'))
    .map((n) => path.join(dir, n))
    .filter((p) => {
      try {
        // statSync follows a link; a directory listing reports a link as not a directory.
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
}

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Where marketplace-package sources live (ADR-0011): the sibling
 * `../xdeck-packages/xdeck-pkg-<name>/` repos a builder has cloned, plus the
 * gitignored `var/package-cache/<ns>/<name>/<version>/` discovery cache.
 *
 * **Why this list exists at all (2026-07-30).** This gate scanned ONLY
 * `<repo>/tenants/<slug>/…` — and the engagement records it exists to police
 * are no longer there. `clienxUserId` / `subjectDependentId` now appear in 20
 * files across five PACKAGE repos (billing-base, crm, loyalty, restroin-core,
 * restroin-crm), including `Order.entity.json`, `Contact.entity.json` and
 * `LoyaltyAccount.entity.json`. The gate still ran, still printed ✅, and
 * covered none of them. Worse, `tenants/` is gitignored, so on a fresh CI
 * checkout it is empty — this lint has plausibly never examined a single file
 * in CI since the records moved.
 *
 * **Why each layout is walked down to its package folders (2026-10-16).** The
 * cache is three levels deep, and the gate took its first level, the namespace,
 * for a package: a hydrated cache read as one tree per namespace, its class walk
 * looked for `<namespace>/classes`, which never exists, and the exemption below
 * missed every cached copy. On a machine with packages installed but not cloned,
 * `--strict` failed as "scanned nothing" with every class file in the cache. On
 * this one every cached version is a LINK to its sibling repo, and a directory
 * listing does not report a link as a directory, so the cache read as empty.
 * Each package folder is now found in both layouts, links followed, and a folder
 * reached twice (a link and its target) is read once.
 *
 * Returns `[{ dir, id, manifest }]`, `id` being `<namespace>/<name>` from the
 * manifest (null with none). `only` replaces discovery with the folders given:
 * the release workflow's checkout of one package.
 */
function packageRoots({ siblingsDir = SIBLINGS_DIR, cacheDir = CACHE_DIR, only = null } = {}) {
  const candidates = only
    ? only.map((d) => path.resolve(d))
    : [...subdirs(siblingsDir), ...subdirs(cacheDir).flatMap(subdirs).flatMap(subdirs)];
  const seen = new Set();
  const roots = [];
  for (const dir of candidates) {
    let real = dir;
    try {
      real = fs.realpathSync(dir);
    } catch {
      // A folder given to --package that is not there: kept, and reported as unread.
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const manifest = readManifest(dir);
    const id = manifest && manifest.namespace && manifest.name ? `${manifest.namespace}/${manifest.name}` : null;
    roots.push({ dir, id, manifest });
  }
  return roots;
}

/** Every file under `dir` whose name `keep` accepts, SKIP_DIRS left out. */
function filesUnder(dir, keep, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) filesUnder(p, keep, out);
    } else if (keep(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** A package file: which package it belongs to, and its path inside that package. */
function packageFile(root, file) {
  return {
    slug: `pkg:${root.id || path.basename(root.dir)}`,
    pkg: root.id,
    inner: path.relative(root.dir, file).split(path.sep).join('/'),
    rootDir: root.dir,
    file
  };
}

/** Every `*.entity.json` in each package folder. */
function packageEntityFiles(roots = packageRoots()) {
  return roots.flatMap((root) =>
    filesUnder(root.dir, (n) => n.endsWith('.entity.json')).map((f) => packageFile(root, f))
  );
}

/** Every server-side source of each package (classes, triggers): the query-level half of the invariant. */
function packageClassFiles(roots = packageRoots()) {
  const isSource = (n) => /\.ts$/.test(n) && !/\.(spec|test)\.ts$/.test(n);
  return roots.flatMap((root) =>
    SOURCE_DIRS.flatMap((sub) => filesUnder(path.join(root.dir, sub), isSource)).map((f) => packageFile(root, f))
  );
}

function tenantEntityFiles(tenantsDir) {
  const out = [];
  if (!fs.existsSync(tenantsDir)) return out;
  for (const slug of fs.readdirSync(tenantsDir)) {
    if (slug.startsWith('_') || slug.startsWith('.')) continue;
    const defsDir = path.join(tenantsDir, slug, 'entities', 'definitions');
    if (!fs.existsSync(defsDir)) continue;
    for (const f of fs.readdirSync(defsDir)) {
      if (f.endsWith('.json')) out.push({ slug, file: path.join(defsDir, f) });
    }
  }
  return out;
}

function tenantClassFiles(tenantsDir) {
  const out = [];
  const walk = (dir, slug) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, slug);
      else if (/\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name)) out.push({ slug, file: p });
    }
  };
  if (!fs.existsSync(tenantsDir)) return out;
  for (const slug of fs.readdirSync(tenantsDir)) {
    if (slug.startsWith('_') || slug.startsWith('.')) continue;
    walk(path.join(tenantsDir, slug, 'classes'), slug);
    walk(path.join(tenantsDir, slug, 'triggers'), slug);
  }
  return out;
}

/** The folders named by `--package DIR` or `--package=DIR`, in order. */
function packageArgs(argv) {
  const dirs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--package') dirs.push(argv[i + 1]);
    else if (String(argv[i]).startsWith('--package=')) dirs.push(argv[i].slice('--package='.length));
  }
  return dirs;
}

/**
 * What a run could not read, one phrase each; empty when it read everything it polices.
 *
 * A run over everything: either kind read zero times. A gate that examined
 * NOTHING must never print a tick. That is how this one spent months reporting ✅
 * after the records it polices moved out from under it — and on a fresh CI
 * checkout `tenants/` is gitignored and empty, so "scanned zero" is the expected
 * shape of the failure, not an exotic one. PER-KIND, not combined: a first cut
 * used `entities === 0 && classes === 0`, and a sabotage that removed only ENTITY
 * discovery sailed through green — 92 class files still scanned while the
 * structural half of the invariant, the half that actually moved, checked nothing.
 *
 * A run over one package (--package): a folder with no manifest naming its
 * package (its exemptions cannot be looked up, and it is likely the wrong folder),
 * or a manifest that provides entities none of whose definitions were read. A
 * package with no class files is a data-only package, not a gap.
 *
 * Either run: an entity definition that is not JSON was not read, so it is named.
 */
function unreadParts({ packageRun, roots, entityFiles, classFiles, unparsed }) {
  const parts = [];
  if (packageRun) {
    for (const root of roots) {
      if (!root.id) {
        parts.push(`no manifest naming the package in ${root.dir}`);
        continue;
      }
      const provides = root.manifest.provides && root.manifest.provides.entities;
      const provided = Array.isArray(provides) ? provides.length : 0;
      if (provided > 0 && !entityFiles.some((f) => f.rootDir === root.dir)) {
        parts.push(`no entity definition of ${root.id}, which provides ${provided}`);
      }
    }
  } else {
    if (entityFiles.length === 0) parts.push('no entity definitions');
    if (classFiles.length === 0) parts.push('no class files');
  }
  if (unparsed.length) parts.push(`${unparsed.length} entity definition(s) that are not JSON (${unparsed.join(', ')})`);
  return parts;
}

/** The second argument replaces the default folders, for the test. */
function main(argv, { siblingsDir, cacheDir, tenantsDir = TENANTS_DIR } = {}) {
  const strict = argv.includes('--strict');
  const json = argv.includes('--json');
  const only = packageArgs(argv);
  if (only.some((d) => !d || d.startsWith('--'))) {
    process.stderr.write('lint-engagement-subject: --package needs a folder: --package DIR\n');
    process.exitCode = 2;
    return null;
  }
  const report = [];
  const unparsed = [];

  // Entity definitions: tenant working trees AND package repos. The records
  // this invariant polices live mostly in the latter now. Given --package, that
  // package alone: the release workflow's checkout.
  const packageRun = only.length > 0;
  const roots = packageRoots({ siblingsDir, cacheDir, only: packageRun ? only : null });
  const entityFiles = [...(packageRun ? [] : tenantEntityFiles(tenantsDir)), ...packageEntityFiles(roots)];
  const classFiles = [...(packageRun ? [] : tenantClassFiles(tenantsDir)), ...packageClassFiles(roots)];
  const where = (f) => ({
    slug: f.slug,
    file: path.relative(REPO_ROOT, f.file),
    pkg: f.pkg || null,
    inner: f.inner || null
  });

  for (const f of entityFiles) {
    let entity;
    try {
      entity = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    } catch {
      unparsed.push(path.relative(REPO_ROOT, f.file));
      continue;
    }
    const v = lintEntity(entity);
    if (v.length) report.push({ kind: 'entity', ...where(f), violations: v });
  }
  for (const f of classFiles) {
    const v = lintSource(fs.readFileSync(f.file, 'utf8'));
    if (v.length) report.push({ kind: 'query', ...where(f), violations: v });
  }

  // Split the findings: NEW violations block, pre-existing tracked ones are
  // reported and counted but do not fail the build. The list may only shrink.
  const grandfathered = report.filter(isGrandfathered);
  const blocking = report.filter((r) => !isGrandfathered(r));
  const blockingTotal = blocking.reduce((s, r) => s + r.violations.length, 0);

  const scanned = { entities: entityFiles.length, classes: classFiles.length, packages: roots.length };
  const unread = unreadParts({ packageRun, roots, entityFiles, classFiles, unparsed });
  const scannedNothing = unread.length > 0;

  const total = report.reduce((s, r) => s + r.violations.length, 0);
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ totalViolations: total, scanned, scannedNothing, unread, report }, null, 2)}\n`
    );
  } else {
    process.stdout.write('§9.61 engagement-subject lint — tenant + package entities and queries\n');
    process.stdout.write(`   scanned ${scanned.entities} entity definition(s), ${scanned.classes} class file(s)\n`);
    process.stdout.write(
      `   package folders read: ${roots.length}${packageRun ? ` (${roots.map((r) => r.id || r.dir).join(', ')})` : ''}\n`
    );
    if (scannedNothing) {
      process.stdout.write(
        `\n  ⚠️  COULD NOT READ what it polices — ${unread.join('; ')}.\n` +
          '      That is a BROKEN GATE, not a clean result: a privacy control that cannot read\n' +
          '      what it polices cannot tell you anything about it. Check that the tenant\n' +
          '      working trees (gitignored — absent on a fresh checkout) and/or the package\n' +
          '      sources (../xdeck-packages, var/package-cache, or the --package folder) are present.\n'
      );
    }
    for (const r of blocking) {
      process.stdout.write(`\n  ⚠️  [${r.kind}] ${r.slug} — ${r.file}\n`);
      for (const v of r.violations) process.stdout.write(`        ${v.message || `L${v.line}: ${v.text}`}\n`);
    }
    if (blockingTotal > 0) {
      process.stdout.write(
        `\n${blockingTotal} NEW violation(s). The engagement-subject invariant is a PRIVACY control — fix before deploy.\n`
      );
    }
    if (grandfathered.length) {
      process.stdout.write(
        `\n  📋 ${grandfathered.length} pre-existing violation(s), tracked and NOT blocking (see GRANDFATHERED):\n`
      );
      for (const r of grandfathered) process.stdout.write(`        ${r.pkg}:${r.inner} — ${r.file}\n`);
      process.stdout.write(
        '      These shipped while this gate was scanning zero files. Each needs a subject\n' +
          '      column OR a reviewed `engagement-subject-lint-ok` opt-out. The list may only shrink.\n'
      );
    }
    if (!scannedNothing && blockingTotal === 0) {
      process.stdout.write(
        report.length
          ? '\n✅ no NEW engagement-subject violations.\n'
          : '✅ every actor-bearing engagement record declares a subject; no actor-only queries.\n'
      );
    }
  }
  // In --strict, a gate that could not read what it polices fails just as hard
  // as one that found a violation: both mean the invariant is unverified.
  // Pre-existing tracked violations are reported but do not block — see GRANDFATHERED.
  if (strict && (blockingTotal > 0 || scannedNothing)) process.exitCode = 1;
  return {
    totalViolations: total,
    blockingTotal,
    grandfathered: grandfathered.length,
    scanned,
    scannedNothing,
    unread,
    report
  };
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  lintEntity,
  lintSource,
  tenantEntityFiles,
  packageRoots,
  packageEntityFiles,
  packageClassFiles,
  main
};
