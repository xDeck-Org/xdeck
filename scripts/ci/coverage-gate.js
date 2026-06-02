#!/usr/bin/env node
/**
 * scripts/ci/coverage-gate.js
 *
 * RELEASE coverage gate — Salesforce-style. Building a package / tenant is
 * unrestricted; RELEASING one is gated on test coverage ≥ threshold.
 *
 * Salesforce blocks an Apex deploy below 75% org coverage; xDeck blocks a
 * package / tenant RELEASE below the platform standard already enforced on the
 * backend core in `.github/workflows/coverage-check.yml`:
 *
 *     statements ≥ 80   branches ≥ 75   functions ≥ 80   lines ≥ 80
 *
 * This is the ONE primitive behind every release gate (one rule, N call sites):
 *   - package release  → `package-release.yml` runs it over the
 *                        package's own unit tests, scoped to the package tree.
 *   - tenant  release  → `tenant-release.yml` runs it over the tenant's tests,
 *                        scoped to `tenants/<slug>/`.
 *   - backend core     → `coverage-check.yml` (can delegate here too).
 *
 * Reads an Istanbul / jest `coverage-summary.json`. With `--scope <substr>` it
 * re-aggregates only the file entries whose path contains <substr>, so a single
 * backend-wide summary yields a per-package or per-tenant number.
 *
 * DATA-ONLY targets (entity-pack packages with NO .ts/.tsx sources — e.g.
 * clinic/edu/retail) have no code to cover. They PASS-BY-E2E: their proof is
 * the install round-trip in `apps/backend/test/package-install.e2e-spec.ts`
 * (the data-driven per-package gate), provided an E2E exists. Use
 * `--has-e2e false` to refuse even that (no test of any kind ⇒ no release).
 *
 * Usage:
 *   node scripts/ci/coverage-gate.js --coverage-summary coverage/coverage-summary.json
 *   node scripts/ci/coverage-gate.js --coverage-summary <p> --scope packages/standard/approvals --target <dir>
 *   node scripts/ci/coverage-gate.js --coverage-summary <p> --statements 85 --branches 80
 *   node scripts/ci/coverage-gate.js --coverage-summary <p> --json
 *
 * Exit 0 = gate passes (≥ thresholds, OR data-only & E2E-covered).
 * Exit 1 = release BLOCKED (below threshold, or no test of any kind).
 * Exit 2 = bad invocation (missing/120 unreadable summary).
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Platform standard — identical to coverage-check.yml so a package/tenant is
// held to the same bar as the core it runs inside. Override per-metric via flags.
const DEFAULT_THRESHOLDS = { statements: 80, branches: 75, functions: 80, lines: 80 };
const METRICS = ['statements', 'branches', 'functions', 'lines'];

/**
 * Coverage percent for one metric entry. Prefers the precomputed `pct` (always
 * present in real Istanbul summaries) but recomputes from covered/total when
 * absent so a malformed summary can't silently skip a metric and let a
 * below-threshold release through (fail-closed). Returns null only when there
 * is genuinely no data for the metric.
 */
function pctOf(entry) {
  if (!entry) return null;
  if (typeof entry.pct === 'number') return entry.pct;
  if (typeof entry.total === 'number') return entry.total === 0 ? 100 : Number(((entry.covered / entry.total) * 100).toFixed(2));
  return null;
}

/**
 * Re-aggregate per-file coverage entries whose path contains `scope` into a
 * single totals object. Pure. When `scope` is falsy, returns `summary.total`
 * unchanged (the whole-report number).
 */
function aggregateScope(summary, scope) {
  if (!scope) return summary.total || null;
  const acc = Object.fromEntries(METRICS.map((m) => [m, { total: 0, covered: 0 }]));
  let matched = 0;
  for (const [file, entry] of Object.entries(summary)) {
    if (file === 'total') continue;
    if (!file.includes(scope)) continue;
    matched++;
    for (const m of METRICS) {
      acc[m].total += entry[m]?.total ?? 0;
      acc[m].covered += entry[m]?.covered ?? 0;
    }
  }
  if (matched === 0) return null; // no files in scope — caller decides (data-only?)
  for (const m of METRICS) {
    const { total, covered } = acc[m];
    acc[m].pct = total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2));
  }
  return acc;
}

/**
 * Decide pass/fail. Pure — this is the heart of the gate and the unit-tested
 * surface.
 *
 * @param {object|null} totals  per-metric { total, covered, pct } (or null = no
 *                              code in scope)
 * @param {object}      opts    { thresholds, hasCode, hasE2e }
 */
function evaluateCoverage(totals, opts = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
  // hasCode: explicit override, else inferred from whether any statements exist.
  const hasCode = opts.hasCode !== undefined ? opts.hasCode : (totals?.statements?.total ?? 0) > 0;
  const hasE2e = opts.hasE2e !== false; // default: assume the central per-package E2E covers it

  if (!hasCode) {
    return {
      pass: hasE2e,
      dataOnly: true,
      thresholds,
      totals: null,
      failures: hasE2e ? [] : [{ metric: 'e2e', reason: 'no code AND no e2e install test — nothing proves this releases cleanly' }],
      reason: hasE2e
        ? 'data-only target — no code to cover; release proven by the e2e install round-trip'
        : 'data-only target with NO e2e install test — release blocked'
    };
  }

  const failures = [];
  for (const m of METRICS) {
    const pct = pctOf(totals?.[m]);
    if (pct === null) continue; // genuinely no data for this metric — can't judge it
    if (pct < thresholds[m]) failures.push({ metric: m, pct, threshold: thresholds[m] });
  }
  return {
    pass: failures.length === 0,
    dataOnly: false,
    thresholds,
    totals,
    failures,
    reason: failures.length === 0 ? 'coverage meets every threshold' : 'coverage below threshold'
  };
}

/** Walk a target dir for first-party code (.ts/.tsx), ignoring tests + vendor. */
function hasCodeFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return undefined; // unknown — let totals decide
  const SKIP = new Set(['node_modules', 'dist', 'coverage', '.git']);
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith('.')) stack.push(path.join(d, e.name));
      } else if (/\.tsx?$/.test(e.name) && !/\.(spec|test|d)\.tsx?$/.test(e.name)) {
        return true;
      }
    }
  }
  return false;
}

function parseArgs(argv) {
  const out = { thresholds: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--coverage-summary') out.coverageSummary = next();
    else if (a === '--scope') out.scope = next();
    else if (a === '--target') out.target = next();
    else if (a === '--label') out.label = next();
    else if (a === '--has-e2e') out.hasE2e = next() !== 'false';
    else if (a === '--json') out.json = true;
    else if (METRICS.includes(a.replace(/^--/, ''))) out.thresholds[a.replace(/^--/, '')] = Number(next());
    else if (a === '--threshold') {
      // single number applied to statements/functions/lines (branches kept at default unless set)
      const v = Number(next());
      out.thresholds.statements = v;
      out.thresholds.functions = v;
      out.thresholds.lines = v;
    }
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  const label = args.label || args.scope || args.target || 'target';
  const diskHasCode = hasCodeFiles(args.target);
  let result;

  // No coverage summary at all. A data-only target (no .ts/.tsx) needs no
  // coverage run — pass-by-E2E. A code-bearing target with NO coverage report
  // means no tests ran ⇒ release BLOCKED. With neither summary nor target we
  // can't judge (bad invocation).
  if (!args.coverageSummary) {
    if (diskHasCode === false) {
      result = evaluateCoverage(null, { thresholds: args.thresholds, hasCode: false, hasE2e: args.hasE2e });
    } else if (diskHasCode === true) {
      result = {
        pass: false,
        dataOnly: false,
        thresholds: { ...DEFAULT_THRESHOLDS, ...(args.thresholds || {}) },
        totals: null,
        failures: [{ metric: 'coverage', reason: 'code present but no coverage report — run tests with --coverage before release' }],
        reason: 'code present but no coverage report was produced'
      };
    } else {
      process.stderr.write('coverage-gate: provide --coverage-summary <path>, or --target <dir> to detect a data-only release.\n');
      process.exitCode = 2;
      return;
    }
    return report(result, label, null, args);
  }

  let summary;
  try {
    summary = JSON.parse(fs.readFileSync(args.coverageSummary, 'utf8'));
  } catch (err) {
    process.stderr.write(`coverage-gate: cannot read coverage summary '${args.coverageSummary}': ${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  const totals = aggregateScope(summary, args.scope);
  const hasCode = totals ? (totals.statements?.total ?? 0) > 0 : diskHasCode === true;
  result = evaluateCoverage(totals, { thresholds: args.thresholds, hasCode, hasE2e: args.hasE2e });
  return report(result, label, totals, args);
}

/** Print the gate result + set the process exit code. */
function report(result, label, totals, args) {
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ label, ...result }, null, 2)}\n`);
  } else {
    process.stdout.write(`Coverage gate — ${label} (thresholds: ${METRICS.map((m) => `${m}≥${result.thresholds[m]}`).join(' ')})\n`);
    if (result.dataOnly) {
      process.stdout.write(`  ${result.pass ? '✅' : '❌'} ${result.reason}\n`);
    } else if (totals) {
      for (const m of METRICS) {
        const pct = pctOf(totals[m]);
        if (pct === null) continue;
        const ok = pct >= result.thresholds[m];
        process.stdout.write(`  ${ok ? '✅' : '❌'} ${m}: ${pct}% (required ≥ ${result.thresholds[m]}%)\n`);
      }
    }
    if (!result.pass) {
      process.stdout.write(`\n❌ RELEASE BLOCKED — ${result.reason}. Raise coverage to the threshold (or add an e2e install test) before tagging.\n`);
    } else {
      process.stdout.write(`\n✅ Release gate passes.\n`);
    }
  }

  process.exitCode = result.pass ? 0 : 1;
  return result;
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { aggregateScope, evaluateCoverage, hasCodeFiles, DEFAULT_THRESHOLDS };
