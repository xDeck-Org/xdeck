/**
 * §9.50 Phase B Slice 7 — static-analysis capability validator (pure-Node).
 *
 * Reads the TypeScript source of every class in a package, resolves each
 * runtime-API call to the capability it needs, and reports the set of
 * capabilities the package USES. Consumers (install-time validator in
 * `apps/backend`, CI driver in `scripts/ci/`) cross-check against
 * `manifest.capabilities` to surface undeclared usage as
 * `PACKAGE_CAPABILITY_UNDECLARED` / unresolvable patterns as
 * `PACKAGE_CAPABILITY_USAGE_UNRESOLVABLE`.
 *
 * **Why static analysis on top of the runtime guard.** The guard refuses every
 * capability a package does not hold — one with no grants is refused every
 * call. So an undeclared call never gains a privilege; it is a package that
 * installs and then fails the first time that code runs, in front of a deck
 * user. The analyzer moves that failure to the author's tag and the operator's
 * install, and keeps the declared set honest for the operator who approves it.
 *
 * **One reading, everywhere (2026-11-07).** Install-time validation, the package
 * release workflow and the sibling-fleet gate run this same walk — there is no
 * mode to choose, so the three cannot disagree. It:
 *  - walks every `.ts` under `<packageDir>/classes/` (jobs, hooks, transforms,
 *    lib), skipping `__tests__/`, `node_modules/`, `*.spec.ts`, `*.test.ts`
 *    and `.d.ts`; a file or a folder it cannot read is a finding, never a skip;
 *  - reads both shapes of a call: the injected global, `xdeck.<domain>.<method>(…)`
 *    (also when read off `globalThis`), and the accessor every first-party
 *    package defines in `lib/runtime.ts`, `xdeck().<domain>.<method>(…)`;
 *  - extracts a parameterized resource from a literal
 *    (`xdeck().entity.read({ entityName: 'Patient' })` → `entity:read:Patient`),
 *    a `const` of literals, a choice between literals, or a column of a const table;
 *  - follows the API through a `const` (lexical scope, shadowing respected), out
 *    of a function that returns it (`requirePayment().initiate(…)`), and into a
 *    parameter every caller fills with it — counting only a function whose
 *    callers are all known: one reached by direct calls alone;
 *  - judges a helper that forwards its parameter as a resource id at its callers;
 *    a plain function nothing calls is dead code, while a method nothing calls
 *    may be an entry point, so its parameters stay unknown;
 *  - reports the API escaping as a value anywhere else (passed, returned, stored,
 *    spread, destructured, indexed) as unresolvable — a gate must fail on what it
 *    cannot read; a truthiness test (`if (api)`) is not an escape. The accessor
 *    itself is called by its own name only: imported or re-exported under
 *    another name, reached through a namespace import, or passed as a value, it
 *    is a finding — the walk knows it by name;
 *  - skips `xdeck.context.*`, `xdeck.config.*` and the identity-scoped methods,
 *    which no grant governs;
 *  - moves a non-literal resource id to `acknowledged` when the statement carries
 *    `// xdeck-capability-dynamic: <why, at least 10 characters>` — returned to
 *    the caller (a warning at install, a listed line in CI), never counted as
 *    declared and never silently passed.
 *
 * **Pure Node.** No `@nestjs/common`, no Nest `Logger`. The `onWarn` option lets
 * consumers route diagnostic messages wherever they want — a Nest service wraps
 * this and pipes them to `Logger.warn`; the CI driver pipes them to `console.warn`.
 *
 * **`typescript` as peerDependency.** Only consumers of the `./static-analyzer`
 * subpath need `typescript` at runtime; types-only consumers of
 * `@xdeck/runtime-api` don't pay for it.
 *
 * **Not in scope:** a resource id computed at run time without the marker (a
 * finding — pass a literal, or mark and declare); the global reached by a
 * computed name (`globalThis[name]`), which no static reading can follow — the
 * guard refuses it like any ungranted call; compiled `.js` source (packages ship
 * `.ts` per ADR 0003).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import {
  capabilityForMethodCall,
  IDENTITY_SCOPED_METHODS,
  lookupXdeckMethod,
  type XdeckMethodMapping
} from './method-mapping';

/** Every class in the package (jobs, hooks, transforms, lib) — ADR 0003 §1 puts them all here. */
const CLASSES_SUBDIR = 'classes';

/** Objects the injected runtime global can be read off: `globalThis.xdeck`, `self['xdeck']`. */
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(['globalThis', 'self', 'window', 'global']);

/** The reason on a dynamic-resource marker must say something. */
const DYNAMIC_MARKER_MIN_NOTE = 10;

export interface CapabilityUsageSite {
  /** File path relative to the package root (e.g. `classes/transforms/Sender.ts`). */
  file: string;
  /** 1-based line number of the call expression. */
  line: number;
}

export interface UsedCapabilityFinding {
  /**
   * Capability string the source-code call resolves to. Typed as `string`
   * (not `Capability`) because the analyzer must report USAGE faithfully —
   * including reserved strings like `'event:emit'` and `'class:invoke'`
   * (per §9.50.9.1) that aren't part of the grantable `Capability` union
   * but ARE valid call sites for the runtime to refuse. Validators treat
   * them all as strings; reservation rejection lives in the manifest
   * `checkCapabilities` path (Slice 2).
   */
  capability: string;
  /** Every distinct call site that resolves to this capability. */
  callSites: CapabilityUsageSite[];
}

export interface UnresolvableUsage {
  file: string;
  line: number;
  /** Source snippet (the offending expression). Useful in error messages. */
  expression: string;
  /** Why it can't be statically resolved. */
  reason: string;
}

export interface AcknowledgedUsage extends UnresolvableUsage {
  /** The author's reason, from the `xdeck-capability-dynamic:` marker. */
  note: string;
}

export interface CapabilityAnalysisResult {
  /** Distinct capabilities the package USES, grouped by capability string. */
  used: UsedCapabilityFinding[];
  /** Call sites that referenced `xdeck` in a way the analyzer cannot resolve. */
  unresolvable: UnresolvableUsage[];
  /**
   * Non-literal resource ids whose statement carries an `xdeck-capability-dynamic:`
   * marker. Reported to the caller, never counted as declared.
   */
  acknowledged: AcknowledgedUsage[];
}

export interface AnalyzeOptions {
  /** Optional diagnostic sink — invoked for unreadable files /
   *  unlistable subdirs. Defaults to no-op. */
  onWarn?: (message: string) => void;
}

const noopWarn = (_: string): void => undefined;

/**
 * Walk every `.ts` class under `<packageDir>/classes/` and collect the
 * capability usage findings. Missing directory → empty result (a package
 * with no classes calls nothing).
 *
 * Consumers cross-reference `used` against the manifest's declared
 * capabilities and use `unresolvable` to fail install/publish with a
 * clear remediation message.
 */
export function analyzePackageDir(packageDir: string, opts: AnalyzeOptions = {}): CapabilityAnalysisResult {
  const onWarn = opts.onWarn ?? noopWarn;
  const used = new Map<string, CapabilityUsageSite[]>();
  const unresolvable: UnresolvableUsage[] = [];
  const acknowledged: AcknowledgedUsage[] = [];
  const scanDir = path.join(packageDir, CLASSES_SUBDIR);
  if (!fs.existsSync(scanDir) || !fs.statSync(scanDir).isDirectory()) {
    return finishResult(used, unresolvable, acknowledged);
  }
  const { files, unlistable } = listTypeScriptFiles(scanDir, onWarn);
  // A folder the walk cannot list hides every class in it: a finding, never a clean verdict.
  for (const { dir, code } of unlistable) {
    unresolvable.push({
      file: path.relative(packageDir, dir),
      line: 0,
      expression: '',
      reason: `unlistable folder — the classes in it cannot be read (${code})`
    });
  }
  // The walk reads the whole package before judging any file: a helper in
  // `classes/transforms/lib/` is resolved where a job or a transform calls it.
  const sources: SourceInput[] = [];
  for (const absPath of files) {
    const relPath = path.relative(packageDir, absPath);
    let source: string;
    try {
      source = fs.readFileSync(absPath, 'utf8');
    } catch (err) {
      onWarn(`could not read ${absPath}: ${(err as Error).message}`);
      unresolvable.push({
        file: relPath,
        line: 0,
        expression: '',
        reason: `unreadable source file (${errorCode(err)})`
      });
      continue;
    }
    sources.push({ file: relPath, source });
  }
  analyzeUnits(sources, used, unresolvable, acknowledged);
  return finishResult(used, unresolvable, acknowledged);
}

/**
 * Pure analysis of a single source string (no fs), read as a one-file
 * package. Exported for tests + consumers who already have the source in memory.
 */
export function analyzeSource(file: string, source: string): CapabilityAnalysisResult {
  const used = new Map<string, CapabilityUsageSite[]>();
  const unresolvable: UnresolvableUsage[] = [];
  const acknowledged: AcknowledgedUsage[] = [];
  analyzeUnits([{ file, source }], used, unresolvable, acknowledged);
  return finishResult(used, unresolvable, acknowledged);
}

function finishResult(
  used: Map<string, CapabilityUsageSite[]>,
  unresolvable: UnresolvableUsage[],
  acknowledged: AcknowledgedUsage[]
): CapabilityAnalysisResult {
  return {
    used: [...used.entries()]
      .map(([capability, callSites]) => ({ capability, callSites }))
      .sort((a, b) => a.capability.localeCompare(b.capability)),
    unresolvable,
    acknowledged
  };
}

interface SourceInput {
  file: string;
  source: string;
}

/**
 * A parameter of a package function that becomes the resource id of a parameterized call —
 * `resolveByCode(entityName, …)`, `idempotentInsert(entityName, …)`. Its callers are
 * judged instead: a literal argument there is the capability.
 */
interface ForwardingHelper {
  paramIndex: number;
  /** The runtime method the parameter reaches, e.g. `entity.read`. */
  method: string;
}

/** Each root is `[]` (the whole `xdeck()`) or `[domain]` (`xdeck().entity`). */
type ApiRoots = string[][];

/** One file of the package, with what its imports bind. */
interface Unit {
  sf: ts.SourceFile;
  /** Local name → the name it was exported under (`import { a as b }` → `b` → `a`). */
  imports: Map<string, string>;
  /** Local names bound by `import * as ns`. */
  namespaces: Set<string>;
}

/**
 * The package's named functions and how each is reached. A function reached only by
 * direct calls the analyzer resolves is CLOSED: its callers are all known, so what its
 * parameters hold and where its return value goes are read at those calls.
 */
interface FunctionIndex {
  /** Plain functions — a declaration, or a `const` bound to an arrow or function expression — by name. */
  plain: Map<string, ts.SignatureDeclaration[]>;
  /** Plain functions another file can import by name. */
  exported: Set<ts.SignatureDeclaration>;
  /** Class methods, by name. */
  methods: Map<string, ts.MethodDeclaration[]>;
  all: Set<ts.SignatureDeclaration>;
  /** The direct calls resolved to each function. */
  calls: Map<ts.SignatureDeclaration, ts.CallExpression[]>;
  /** Functions also reached another way — passed, stored, re-exported, called on another object. */
  open: Set<ts.SignatureDeclaration>;
}

/** Where the API flows between closed functions. */
interface ApiIndex {
  /** Functions whose every value-carrying return is the API or a domain of it. */
  returns: Map<ts.SignatureDeclaration, ApiRoots>;
  /** Parameters every caller fills with the API or a domain of it. */
  params: Map<ts.ParameterDeclaration, ApiRoots>;
}

/** What resolving a name or a call needs: its file, and the package's indexes. */
interface Resolver {
  unit: Unit;
  fns: FunctionIndex;
  api: ApiIndex;
}

/** The walk's state for one file. */
interface AccessorContext extends Resolver {
  /** Names bound in the file to the API — `const` aliases and API parameters. A pre-filter: each use is confirmed by its binding. */
  aliasNames: ReadonlySet<string>;
  acknowledged: AcknowledgedUsage[];
  /** Package-wide, by function. */
  helpers: ReadonlyMap<ts.SignatureDeclaration, ForwardingHelper[]>;
}

/**
 * The walk: index the whole package — its functions, where the API flows between
 * them, its forwarding helpers — then judge every file.
 */
function analyzeUnits(
  sources: SourceInput[],
  used: Map<string, CapabilityUsageSite[]>,
  unresolvable: UnresolvableUsage[],
  acknowledged: AcknowledgedUsage[]
): void {
  const units = sources.map(({ file, source }) =>
    toUnit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, /*setParentNodes*/ true))
  );
  const fns = buildFunctionIndex(units);
  const api = buildApiIndex(units, fns);
  const contexts = units.map((unit): AccessorContext => {
    const resolver: Resolver = { unit, fns, api };
    return { ...resolver, aliasNames: collectAliasNames(resolver), acknowledged, helpers: new Map() };
  });
  const helpers = buildHelperIndex(contexts, fns);
  for (const context of contexts) {
    const accessor: AccessorContext = { ...context, helpers };
    const sf = context.unit.sf;
    const visit = (node: ts.Node): void => {
      if (isGlobalObjectApiRef(node)) {
        // `globalThis.xdeck` is the API itself, like `xdeck()`: the chains above it are judged
        // where they are accessed; here it may only stay where the analyzer reads it.
        inspectBareAccessor(node, sf, unresolvable, accessor);
      } else if (ts.isPropertyAccessExpression(node)) {
        inspectPropertyAccess(node, sf, used, unresolvable, accessor);
        inspectNamespacedAccessor(node, sf, unresolvable, accessor);
      } else if (isAccessorCall(node)) {
        inspectBareAccessor(node, sf, unresolvable, accessor);
      } else if (ts.isCallExpression(node)) {
        inspectHelperCall(node, sf, used, unresolvable, accessor);
        inspectApiCall(node, sf, unresolvable, accessor);
      } else if (ts.isIdentifier(node)) {
        if (node.text === 'xdeck') inspectXdeckName(node, sf, unresolvable, accessor);
        else if (accessor.aliasNames.has(node.text)) inspectAliasReference(node, sf, unresolvable, accessor);
      } else if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
        inspectRenamedAccessor(node, sf, unresolvable, accessor);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

function recordUse(used: Map<string, CapabilityUsageSite[]>, capability: string, file: string, line: number): void {
  const sites = used.get(capability) ?? [];
  sites.push({ file, line });
  used.set(capability, sites);
}

/**
 * A finding whose statement (or an enclosing statement in the same function) carries a
 * reasoned `xdeck-capability-dynamic:` marker is acknowledged, not passed. An unknown
 * method is never acknowledgeable — the runtime would refuse it by name.
 */
function pushUnresolvable(
  site: UnresolvableUsage,
  at: ts.Node,
  sf: ts.SourceFile,
  unresolvable: UnresolvableUsage[],
  accessor: AccessorContext,
  acknowledgeable = true
): void {
  const note = acknowledgeable ? dynamicMarkerNote(at, sf) : null;
  if (note) accessor.acknowledged.push({ ...site, note });
  else unresolvable.push(site);
}

function inspectPropertyAccess(
  node: ts.PropertyAccessExpression,
  sf: ts.SourceFile,
  used: Map<string, CapabilityUsageSite[]>,
  unresolvable: UnresolvableUsage[],
  accessor: AccessorContext
): void {
  const alternatives = resolveAccessorChain(node, accessor);
  if (!alternatives) return;
  const { outer, child } = climbWrappers(node);
  const partOfDeeperChain = !!outer && ts.isPropertyAccessExpression(outer) && outer.expression === child;
  const callee = outer && ts.isCallExpression(outer) && outer.expression === child ? outer : null;
  const seen = new Set<string>();
  for (const members of alternatives) {
    // A domain on its own — bound to a `const`, probed (`if (!xdeck().job)`), returned from a
    // function that returns the API, passed to an API parameter — calls nothing here; its
    // calls are read where they happen.
    if (members.length === 1 && !partOfDeeperChain && isApiSink(node, accessor)) continue;
    judgeChain(node, members, partOfDeeperChain, callee, sf, used, unresolvable, accessor, seen);
  }
}

/**
 * One resolved chain: the capability of a known method called with a knowable resource,
 * or a finding. A chain with several roots (`api.send` where `api` is email or sms) is
 * judged once per root; `seen` keeps their shared findings single.
 */
function judgeChain(
  node: ts.PropertyAccessExpression,
  members: string[],
  partOfDeeperChain: boolean,
  callee: ts.CallExpression | null,
  sf: ts.SourceFile,
  used: Map<string, CapabilityUsageSite[]>,
  unresolvable: UnresolvableUsage[],
  accessor: AccessorContext,
  seen: Set<string> = new Set()
): void {
  // `xdeck.context.<field>` — always-available identity, no capability check.
  if (members[0] === 'context') return;
  // §9.52 `xdeck.config.get()` — identity-scoped read of the calling
  // package's OWN install settings (own tenant only). Non-grantable, same
  // posture as `context`; nothing cross-boundary to gate.
  if (members[0] === 'config') return;
  // §9.169 PR-10 — the other identity-scoped methods (`xdeck.capabilities.invoke`, `xdeck.integrator.callout`,
  // `xdeck.integrator.settings`): gated parent-side by the broker or by the handler run the parent set, never
  // by a grant, so no package `capabilities` list can name them and there is nothing here to resolve. Skipped
  // per METHOD, not per domain: `xdeck.integrator.frobnicate()` is still an unknown method below.
  if (members.length >= 2 && IDENTITY_SCOPED_METHODS.includes(`${members[0]}.${members[1]}`)) {
    return;
  }
  const depth = members.length;
  // Skip 1-deep nodes that are part of a deeper chain (avoid double-firing
  // when visiting `xdeck.email.send` — we'd otherwise also visit the inner
  // `xdeck.email` and double-flag).
  if (depth === 1 && partOfDeeperChain) {
    return;
  }
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const expression = node.getText(sf);
  const flag = (site: UnresolvableUsage, acknowledgeable = true): void => {
    const key = `${site.line}|${site.reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    pushUnresolvable(site, node, sf, unresolvable, accessor, acknowledgeable);
  };
  if (depth !== 2) {
    // 1-deep standalone (`const e = xdeck.email`) OR 3+ deep
    // (`xdeck.email.send.bind(...)`). Both are forms the analyzer cannot
    // map to a single capability. The caller blocks install/publish.
    flag({
      file: sf.fileName,
      line: line + 1,
      expression,
      reason:
        depth === 1
          ? `partial member access — bind the domain to a \`const\` (\`const api = xdeck().entity\`) or call \`xdeck().<domain>.<method>(...)\` directly`
          : `chained method access (depth ${depth}) — only \`xdeck().<domain>.<method>(...)\` and \`xdeck.<domain>.<method>(...)\` calls are statically analysable`
    });
    return;
  }
  // Exactly 2-deep. Either a method call (extract capability) or a loose reference.
  const method = `${members[0]}.${members[1]}`;
  const isCallee = callee;
  if (!isCallee) {
    // `typeof consumer.updateOwnProfile !== 'function'` probes an older host; it calls nothing.
    if (isTruthinessPosition(climbWrappers(node).child)) return;
    flag({
      file: sf.fileName,
      line: line + 1,
      expression,
      reason: `\`${expression}\` referenced without immediate call — store the call's RESULT, not the method itself, so the analyzer can see what's being invoked`
    });
    return;
  }
  const mapping = lookupXdeckMethod(method);
  if (!mapping) {
    // Unknown method. Runtime would reject with XDECK_UNKNOWN_METHOD; the
    // analyzer flags here so install fails early with a clearer reason.
    flag(
      {
        file: sf.fileName,
        line: line + 1,
        expression,
        // The catalogue: §9.50.
        reason: `unknown runtime-API method \`xdeck.${method}(...)\` — not in the runtime-API catalogue`
      },
      false
    );
    return;
  }
  const capability = resolveCapability(method, mapping, isCallee, expression);
  if (!capability.ok) {
    if (mapping.kind === 'parameterized') {
      const arg = resourceArgExpression(isCallee, mapping.argKey);
      // A const of literals, a choice between literals, or a column of a const table: every value is known.
      const literals = arg ? literalValues(arg) : null;
      if (literals) {
        for (const value of literals) {
          const cap = capabilityForMethodCall(method, value);
          if (cap) recordUse(used, cap, sf.fileName, line + 1);
        }
        return;
      }
      // A parameter of a forwarding helper: its callers are judged where they pass the value.
      if (arg && isForwardedByHelper(arg, method, accessor)) return;
    }
    flag({ file: sf.fileName, line: line + 1, expression, reason: capability.reason });
    return;
  }
  // Every capability the call needs, not just the method's own: a composed method
  // (`invoice.collectOnline` needs `invoice:settle` AND `payment:initiate`) records both at
  // this site, so declaring only one fails the publish check instead of the first real call.
  const extra = mapping.kind === 'static' ? (mapping.alsoRequires ?? []) : [];
  for (const cap of [capability.value, ...extra]) {
    const sites = used.get(cap) ?? [];
    sites.push({ file: sf.fileName, line: line + 1 });
    used.set(cap, sites);
  }
}

function resolveCapability(
  method: string,
  mapping: XdeckMethodMapping,
  call: ts.CallExpression,
  expression: string
): { ok: true; value: string } | { ok: false; reason: string } {
  if (mapping.kind === 'static' || mapping.kind === 'reserved') {
    const cap = capabilityForMethodCall(method);
    if (!cap) return { ok: false, reason: 'internal: unknown method despite lookup' };
    return { ok: true, value: cap };
  }
  // parameterized — extract literal resource id from the first arg.
  const resourceId = extractLiteralArg(call, mapping.argKey);
  if (!resourceId) {
    return {
      ok: false,
      reason: `\`${expression}\` requires a literal-string \`${mapping.argKey}\` in the first argument so the analyzer can compute the capability; non-literal references cannot be statically resolved`
    };
  }
  const cap = capabilityForMethodCall(method, resourceId);
  if (!cap) return { ok: false, reason: 'internal: parameterized lookup failed' };
  return { ok: true, value: cap };
}

/** Every class source under `dir`, and every folder the walk could not list (each one hides classes). */
/**
 * The error's code (`EACCES`, `ENOENT`, …) for a finding's reason. The full message names the
 * server's absolute path, so it goes to `onWarn` (the server log), never into a finding that the
 * install preview shows its caller.
 */
function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'read error';
}

function listTypeScriptFiles(
  dir: string,
  onWarn: (msg: string) => void
): { files: string[]; unlistable: { dir: string; code: string }[] } {
  const files: string[] = [];
  const unlistable: { dir: string; code: string }[] = [];
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      onWarn(`could not list ${current}: ${(err as Error).message}`);
      unlistable.push({ dir: current, code: errorCode(err) });
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        // Specs mock `xdeck`; they run in the sibling harness, never in a sandbox.
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        if (/\.(spec|test)\.ts$/.test(entry.name)) continue;
        files.push(full);
      }
    }
  };
  walk(dir);
  return { files: files.sort(), unlistable };
}

// ─── the runtime API's roots ─────────────────────────────────────────

/** `xdeck()` — the zero-argument accessor every first-party package imports from `./lib/runtime`. */
function isAccessorCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'xdeck' &&
    node.arguments.length === 0
  );
}

/** `globalThis.xdeck` / `globalThis['xdeck']` (or off `self`, `window`, `global`): the injected runtime global. */
function isGlobalObjectApiRef(node: ts.Node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  let object: ts.Expression;
  if (ts.isPropertyAccessExpression(node)) {
    if (node.name.text !== 'xdeck') return false;
    object = node.expression;
  } else if (ts.isElementAccessExpression(node)) {
    const key = stripWrappers(node.argumentExpression);
    if (!ts.isStringLiteralLike(key) || key.text !== 'xdeck') return false;
    object = node.expression;
  } else {
    return false;
  }
  const head = stripWrappers(object);
  return ts.isIdentifier(head) && GLOBAL_OBJECTS.has(head.text) && !findBinding(head);
}

/** `declare const xdeck: …` — names the injected global; it binds no value of its own. */
function isAmbientVariable(binding: ts.Node): boolean {
  if (!ts.isVariableDeclaration(binding)) return false;
  const statement = binding.parent?.parent;
  return (
    !!statement &&
    ts.isVariableStatement(statement) &&
    (statement.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)
  );
}

/** A bare `xdeck` that names the injected runtime global: no binding in scope, or only an ambient one. */
function isGlobalXdeck(id: ts.Identifier): boolean {
  if (id.text !== 'xdeck') return false;
  const binding = findBinding(id);
  return !binding || isAmbientVariable(binding);
}

/**
 * The package's own accessor: a zero-parameter function named `xdeck` (a declaration, or a
 * `const` bound to one). What it returns is the API — its callers are read by that name.
 */
function isAccessorDefinition(fn: ts.Node | null): boolean {
  if (!fn || !ts.isFunctionLike(fn) || fn.parameters.length > 0) return false;
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text === 'xdeck';
  if (!ts.isFunctionExpression(fn) && !ts.isArrowFunction(fn)) return false;
  const { outer } = climbWrappers(fn);
  return !!outer && ts.isVariableDeclaration(outer) && ts.isIdentifier(outer.name) && outer.name.text === 'xdeck';
}

/** Expressions that change a type, not a value: `(x)`, `x!`, `x as T`, `<T>x`, `x satisfies T`. */
function isValueWrapper(
  node: ts.Node
): node is
  ts.ParenthesizedExpression | ts.NonNullExpression | ts.AsExpression | ts.TypeAssertion | ts.SatisfiesExpression {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node)
  );
}

function stripWrappers(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (isValueWrapper(current)) current = current.expression;
  return current;
}

/** The nearest ancestor that is not a value wrapper, and the node directly under it. */
function climbWrappers(node: ts.Node): { outer: ts.Node | undefined; child: ts.Node } {
  let child = node;
  let outer = node.parent;
  while (outer && isValueWrapper(outer)) {
    child = outer;
    outer = outer.parent;
  }
  return { outer, child };
}

/** Pre-order walk of a subtree. */
function walkTree(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => walkTree(child, fn));
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Members of an `xdeck` chain in the accessor walk — one list per root the chain can start
 * from — or `null` when the chain is not rooted at the API. Roots: `xdeck.<…>`, `xdeck().<…>`,
 * a `const` alias or an API parameter (`api.read` → `[['entity', 'read']]`), or a call to a
 * function that returns the API (`requirePayment().initiate` → `[['payment', 'initiate']]`).
 * Value wrappers inside the chain (`xdeck().entity!.read`) are looked through.
 */
function resolveAccessorChain(node: ts.PropertyAccessExpression, ctx: AccessorContext): string[][] | null {
  const members: string[] = [];
  let current: ts.Expression = node;
  for (;;) {
    if (members.length > 0 && isGlobalObjectApiRef(current)) return [members];
    if (ts.isPropertyAccessExpression(current)) {
      members.unshift(current.name.text);
      current = current.expression;
    } else if (isValueWrapper(current)) {
      current = current.expression;
    } else {
      break;
    }
  }
  if (ts.isIdentifier(current) && current.text === 'xdeck') return [members];
  if (isAccessorCall(current)) return [members];
  const candidate = ts.isIdentifier(current)
    ? ctx.aliasNames.has(current.text)
    : ts.isCallExpression(current) && ctx.api.returns.size > 0;
  if (!candidate) return null;
  const roots = apiRoots(current, ctx);
  return roots ? roots.map((root) => [...root, ...members]) : null;
}

/** `undefined`, `null` or `void 0` — a return or a branch that carries no API. */
function isNothing(expr: ts.Expression): boolean {
  const e = stripWrappers(expr);
  return (
    e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined') || ts.isVoidExpression(e)
  );
}

function uniqueRoots(roots: ApiRoots): ApiRoots {
  const byKey = new Map<string, string[]>();
  for (const root of roots) byKey.set(root.join('.'), root);
  return [...byKey.values()];
}

/**
 * The roots an expression has when it is the runtime API, or `null` when it is not (or not
 * knowably) the API: `xdeck()`, `xdeck().<domain>`, a `const` bound to either, an API
 * parameter, a call to a function that returns the API, or a choice between those (a
 * `null` / `undefined` branch carries none).
 */
function apiRoots(expr: ts.Expression, r: Resolver, depth = 0): ApiRoots | null {
  if (depth > 8) return null;
  const e = stripWrappers(expr);
  if (isAccessorCall(e) || isGlobalObjectApiRef(e)) return [[]];
  if (ts.isPropertyAccessExpression(e)) {
    const head = stripWrappers(e.expression);
    if (ts.isIdentifier(head) && head.text === 'xdeck') return [[e.name.text]];
    const inner = apiRoots(head, r, depth + 1);
    // `x.email` where `x` is the whole API is a domain; `api.read` where `api` is a domain is a method, not the API.
    return inner && inner.every((root) => root.length === 0) ? [[e.name.text]] : null;
  }
  if (ts.isIdentifier(e)) {
    if (isGlobalXdeck(e)) return [[]];
    const binding = findBinding(e);
    if (!binding) return null;
    if (ts.isParameter(binding)) return r.api.params.get(binding) ?? null;
    if (
      ts.isVariableDeclaration(binding) &&
      ts.isIdentifier(binding.name) &&
      binding.initializer &&
      isConstDeclaration(binding)
    ) {
      return apiRoots(binding.initializer, r, depth + 1);
    }
    return null;
  }
  const roots: ApiRoots = [];
  if (ts.isCallExpression(e)) {
    const targets = callTargets(e, r);
    if (targets.length === 0) return null;
    for (const target of targets) {
      const returned = r.api.returns.get(target);
      if (!returned) return null;
      roots.push(...returned);
    }
    return uniqueRoots(roots);
  }
  if (ts.isConditionalExpression(e)) {
    for (const branch of [e.whenTrue, e.whenFalse]) {
      if (isNothing(branch)) continue;
      const found = apiRoots(branch, r, depth + 1);
      if (!found) return null;
      roots.push(...found);
    }
    return roots.length > 0 ? uniqueRoots(roots) : null;
  }
  return null;
}

/** Names bound in a file to the API: `const` aliases and API parameters. */
function collectAliasNames(r: Resolver): Set<string> {
  const names = new Set<string>();
  walkTree(r.unit.sf, (node) => {
    if (ts.isParameter(node)) {
      if (ts.isIdentifier(node.name) && r.api.params.has(node)) names.add(node.name.text);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isConstDeclaration(node) &&
      apiRoots(node.initializer, r)
    ) {
      names.add(node.name.text);
    }
  });
  return names;
}

// ─── accessor form: the package's functions ──────────────────────────

function toUnit(sf: ts.SourceFile): Unit {
  const imports = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause || st.importClause.isTypeOnly) continue;
    const bindings = st.importClause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    else
      for (const el of bindings.elements)
        if (!el.isTypeOnly) imports.set(el.name.text, (el.propertyName ?? el.name).text);
  }
  return { sf, imports, namespaces };
}

/** Index the package's named functions, then every way each one is reached. */
function buildFunctionIndex(units: Unit[]): FunctionIndex {
  const fns: FunctionIndex = {
    plain: new Map(),
    exported: new Set(),
    methods: new Map(),
    all: new Set(),
    calls: new Map(),
    open: new Set()
  };
  const addPlain = (name: string, fn: ts.SignatureDeclaration, flags: ts.ModifierFlags): void => {
    pushTo(fns.plain, name, fn);
    fns.all.add(fn);
    if (flags & ts.ModifierFlags.Export) fns.exported.add(fn);
    // `export default` is imported under any name, so its callers cannot be found.
    if (flags & ts.ModifierFlags.Default) fns.open.add(fn);
  };
  for (const { sf } of units) {
    walkTree(sf, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        addPlain(node.name.text, node, ts.getCombinedModifierFlags(node));
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        isConstDeclaration(node)
      ) {
        const init = stripWrappers(node.initializer);
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          addPlain(node.name.text, init, ts.getCombinedModifierFlags(node));
        }
      } else if (
        ts.isMethodDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.body &&
        ts.isClassLike(node.parent)
      ) {
        pushTo(fns.methods, node.name.text, node);
        fns.all.add(node);
      }
    });
  }
  for (const unit of units) {
    walkTree(unit.sf, (node) => {
      if (ts.isCallExpression(node)) {
        for (const target of callTargets(node, { unit, fns })) pushTo(fns.calls, target, node);
      } else if (ts.isIdentifier(node)) {
        noteIdentifierReference(node, unit, fns);
      } else if (ts.isPropertyAccessExpression(node)) {
        noteMemberReference(node, unit, fns);
      } else if (ts.isElementAccessExpression(node)) {
        noteElementReference(node, fns);
      } else if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamespaceExport(node.exportClause)) {
        // `export * as ns from …` hands every export to callers the analyzer cannot follow.
        for (const fn of fns.exported) fns.open.add(fn);
      }
    });
  }
  return fns;
}

function exportedPlain(name: string, fns: FunctionIndex): ts.SignatureDeclaration[] {
  return (fns.plain.get(name) ?? []).filter((fn) => fns.exported.has(fn));
}

function isImportBinding(id: ts.Identifier): boolean {
  const binding = findBinding(id);
  return !!binding && ts.isImportDeclaration(binding);
}

/**
 * The package functions a call reaches: a plain function by its binding (an import by the
 * name it was exported under, `ns.f()` through `import * as ns`), a method through `this`
 * by its class — or by name, when the class inherits it. Anything else reaches nothing known.
 */
function callTargets(call: ts.CallExpression, r: Pick<Resolver, 'unit' | 'fns'>): ts.SignatureDeclaration[] {
  const callee = stripWrappers(call.expression);
  if (ts.isIdentifier(callee)) return plainTargets(callee, r);
  if (!ts.isPropertyAccessExpression(callee)) return [];
  const head = stripWrappers(callee.expression);
  if (head.kind === ts.SyntaxKind.ThisKeyword) return methodTargets(callee, r.fns);
  if (ts.isIdentifier(head) && r.unit.namespaces.has(head.text) && isImportBinding(head)) {
    return exportedPlain(callee.name.text, r.fns);
  }
  return [];
}

function plainTargets(id: ts.Identifier, r: Pick<Resolver, 'unit' | 'fns'>): ts.SignatureDeclaration[] {
  const imported = r.unit.imports.get(id.text);
  if (imported === undefined && !r.fns.plain.has(id.text)) return [];
  const binding = findBinding(id);
  if (!binding) return [];
  if (ts.isImportDeclaration(binding)) return imported === undefined ? [] : exportedPlain(imported, r.fns);
  const decl = ts.isVariableDeclaration(binding) && binding.initializer ? stripWrappers(binding.initializer) : binding;
  return (r.fns.plain.get(id.text) ?? []).filter((fn) => fn === decl);
}

/** The class `this` means at a node, or `null` inside a non-arrow function or an object literal's method. */
function thisClass(node: ts.Node): ts.ClassLikeDeclaration | null {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isClassLike(cur)) return cur;
    if (ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur)) return null;
    if (
      (ts.isMethodDeclaration(cur) || ts.isGetAccessorDeclaration(cur) || ts.isSetAccessorDeclaration(cur)) &&
      ts.isObjectLiteralExpression(cur.parent)
    ) {
      return null;
    }
  }
  return null;
}

function methodTargets(access: ts.PropertyAccessExpression, fns: FunctionIndex): ts.MethodDeclaration[] {
  const all = fns.methods.get(access.name.text);
  const cls = all ? thisClass(access) : null;
  if (!all || !cls) return [];
  const own = all.filter((m) => m.parent === cls);
  return own.length > 0 ? own : all;
}

/** Whether an identifier reads a binding — not a declaration's name, a member or key name, a label, or a type. */
function isValueReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (ts.isShorthandPropertyAssignment(p) || ts.isExportSpecifier(p) || ts.isExportAssignment(p)) return true;
  if (ts.isPropertyAccessExpression(p)) return p.expression === id;
  if (ts.isTypeQueryNode(p) || ts.isTypeReferenceNode(p) || ts.isQualifiedName(p)) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakStatement(p) || ts.isContinueStatement(p)) return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return false;
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  return (p as { name?: ts.Node }).name !== id;
}

/**
 * A plain function named anywhere but a direct call — passed, stored, exported under another
 * name — is open; so is every export when an `import * as ns` object is used as a value.
 */
function noteIdentifierReference(id: ts.Identifier, unit: Unit, fns: FunctionIndex): void {
  if (unit.namespaces.has(id.text)) {
    const p = id.parent;
    const member = !!p && ts.isPropertyAccessExpression(p) && p.expression === id;
    if (!member && isValueReference(id) && isImportBinding(id)) for (const fn of fns.exported) fns.open.add(fn);
    return;
  }
  const imported = unit.imports.get(id.text);
  if (imported === undefined && !fns.plain.has(id.text)) return;
  if (!isValueReference(id)) return;
  const spec = id.parent;
  if (ts.isExportSpecifier(spec) && spec.parent.parent.moduleSpecifier) {
    // `export { f as g } from './runtime'` — callers of `g` are not found under `f`.
    for (const fn of exportedPlain((spec.propertyName ?? spec.name).text, fns)) fns.open.add(fn);
    return;
  }
  const { outer, child } = climbWrappers(id);
  if (outer && ts.isCallExpression(outer) && outer.expression === child) return; // a direct call
  const binding = findBinding(id);
  if (!binding) return;
  if (ts.isImportDeclaration(binding)) {
    for (const fn of imported === undefined ? [] : exportedPlain(imported, fns)) fns.open.add(fn);
    return;
  }
  const decl = ts.isVariableDeclaration(binding) && binding.initializer ? stripWrappers(binding.initializer) : binding;
  for (const fn of fns.plain.get(id.text) ?? []) if (fn === decl) fns.open.add(fn);
}

/** A method named other than as `this.m(…)` — `obj.m(…)`, `this.m` passed on, `super.m()` — is open; so is `ns.f` not called. */
function noteMemberReference(access: ts.PropertyAccessExpression, unit: Unit, fns: FunctionIndex): void {
  const name = access.name.text;
  const head = stripWrappers(access.expression);
  const { outer, child } = climbWrappers(access);
  const called = !!outer && ts.isCallExpression(outer) && outer.expression === child;
  const methods = fns.methods.get(name);
  if (methods && !(called && head.kind === ts.SyntaxKind.ThisKeyword && thisClass(access))) {
    for (const m of methods) fns.open.add(m);
  }
  if (!called && ts.isIdentifier(head) && unit.namespaces.has(head.text)) {
    for (const fn of exportedPlain(name, fns)) fns.open.add(fn);
  }
}

/** `x['m']` names a function by string; `this[key]` can reach any method of its class. */
function noteElementReference(access: ts.ElementAccessExpression, fns: FunctionIndex): void {
  const arg = access.argumentExpression;
  if (ts.isStringLiteralLike(arg)) {
    for (const m of fns.methods.get(arg.text) ?? []) fns.open.add(m);
    for (const fn of fns.plain.get(arg.text) ?? []) fns.open.add(fn);
    return;
  }
  if (stripWrappers(access.expression).kind !== ts.SyntaxKind.ThisKeyword) return;
  const cls = thisClass(access);
  if (!cls) return;
  for (const list of fns.methods.values()) for (const m of list) if (m.parent === cls) fns.open.add(m);
}

// ─── accessor form: where the API flows ──────────────────────────────

/**
 * Which closed functions return the API, and which parameters of closed functions receive
 * it — to a fixpoint, since one feeds the other (`loadChildren(api, …)` where
 * `api = requireEntity()`). Starting from nothing, it can only under-count: what it
 * misses stays an escape.
 */
function buildApiIndex(units: Unit[], fns: FunctionIndex): ApiIndex {
  const api: ApiIndex = { returns: new Map(), params: new Map() };
  const unitOf = new Map(units.map((u) => [u.sf, u] as const));
  const resolver = (node: ts.Node): Resolver => ({ unit: unitOf.get(node.getSourceFile()) as Unit, fns, api });
  for (let round = 0, changed = true; changed && round < 10; round++) {
    changed = false;
    for (const fn of fns.all) {
      if (fns.open.has(fn)) continue;
      const roots = returnedRoots(fn, resolver(fn));
      if (roots && setRoots(api.returns, fn, roots)) changed = true;
    }
    for (const [fn, calls] of fns.calls) {
      if (fns.open.has(fn)) continue;
      fn.parameters.forEach((param, index) => {
        const roots = argumentRoots(param, index, calls, resolver);
        if (roots && setRoots(api.params, param, roots)) changed = true;
      });
    }
  }
  return api;
}

/** The roots a function returns when every value it returns is the API (or nothing); otherwise `null`. */
function returnedRoots(fn: ts.SignatureDeclaration, r: Resolver): ApiRoots | null {
  const body = (fn as ts.FunctionLikeDeclarationBase).body;
  if (!body) return null;
  const values: ts.Expression[] = [];
  if (ts.isBlock(body)) {
    const collect = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) || ts.isClassLike(node)) return; // they return for themselves
      if (ts.isReturnStatement(node) && node.expression) values.push(node.expression);
      ts.forEachChild(node, collect);
    };
    ts.forEachChild(body, collect);
  } else {
    values.push(body);
  }
  const roots: ApiRoots = [];
  for (const value of values) {
    if (isNothing(value)) continue;
    const found = apiRoots(value, r);
    if (!found) return null;
    roots.push(...found);
  }
  return roots.length > 0 ? uniqueRoots(roots) : null;
}

/** The roots every call passes for one parameter, or `null` unless every call passes the API there. */
function argumentRoots(
  param: ts.ParameterDeclaration,
  index: number,
  calls: ts.CallExpression[],
  resolver: (node: ts.Node) => Resolver
): ApiRoots | null {
  if (!ts.isIdentifier(param.name) || param.dotDotDotToken) return null;
  const roots: ApiRoots = [];
  for (const call of calls) {
    if (call.arguments.slice(0, index + 1).some(ts.isSpreadElement)) return null;
    const arg = call.arguments[index];
    let found: ApiRoots | null = null;
    if (arg) found = apiRoots(arg, resolver(call));
    else if (param.initializer) found = apiRoots(param.initializer, resolver(param));
    if (!found) return null;
    roots.push(...found);
  }
  return roots.length > 0 ? uniqueRoots(roots) : null;
}

function setRoots<K>(map: Map<K, ApiRoots>, key: K, roots: ApiRoots): boolean {
  const signature = (rs: ApiRoots): string =>
    rs
      .map((root) => root.join('.'))
      .sort()
      .join('|');
  const before = map.get(key);
  if (before && signature(before) === signature(roots)) return false;
  map.set(key, roots);
  return true;
}

function bindsName(name: ts.BindingName, wanted: string): boolean {
  if (ts.isIdentifier(name)) return name.text === wanted;
  return name.elements.some((el) => !ts.isOmittedExpression(el) && bindsName(el.name, wanted));
}

function importBinds(decl: ts.ImportDeclaration, wanted: string): boolean {
  const clause = decl.importClause;
  if (!clause) return false;
  if (clause.name?.text === wanted) return true;
  const bindings = clause.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return bindings.name.text === wanted;
  return bindings.elements.some((el) => el.name.text === wanted);
}

/**
 * The declaration an identifier refers to, by lexical scope: the nearest enclosing function
 * parameter, catch variable, loop variable, or statement-list declaration with that name.
 * Enough to tell `const api = xdeck().entity` from a parameter that shadows it.
 */
function findBinding(id: ts.Identifier): ts.Node | null {
  const wanted = id.text;
  for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      for (const param of scope.parameters) if (bindsName(param.name, wanted)) return param;
    }
    if (ts.isCatchClause(scope) && scope.variableDeclaration && bindsName(scope.variableDeclaration.name, wanted)) {
      return scope.variableDeclaration;
    }
    if (
      (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) &&
      scope.initializer &&
      ts.isVariableDeclarationList(scope.initializer)
    ) {
      for (const decl of scope.initializer.declarations) if (bindsName(decl.name, wanted)) return decl;
    }
    const statements =
      ts.isBlock(scope) ||
      ts.isSourceFile(scope) ||
      ts.isModuleBlock(scope) ||
      ts.isCaseClause(scope) ||
      ts.isDefaultClause(scope)
        ? scope.statements
        : undefined;
    if (!statements) continue;
    for (const st of statements) {
      if (ts.isVariableStatement(st)) {
        for (const decl of st.declarationList.declarations) if (bindsName(decl.name, wanted)) return decl;
      } else if (
        (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) &&
        st.name?.text === wanted
      ) {
        return st;
      } else if (ts.isImportDeclaration(st) && importBinds(st, wanted)) {
        return st;
      }
    }
  }
  return null;
}

/** A position that tests a value without passing it on: `if (x)`, `!x`, `x && …`, `x === y`, `typeof x`. */
function isTruthinessPosition(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if ((ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) && p.expression === node) return true;
  if (ts.isConditionalExpression(p) && p.condition === node) return true;
  if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return true;
  if (ts.isTypeOfExpression(p)) return true;
  if (ts.isBinaryExpression(p)) {
    const op = p.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken && p.left === node) return true;
    if (
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      return true;
    }
  }
  return false;
}

function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | null {
  for (let cur = node.parent; cur; cur = cur.parent) if (ts.isFunctionLike(cur)) return cur;
  return null;
}

/**
 * Whether an API value at `node` stays where the analyzer reads it: the head of a chain
 * (`requirePayment().initiate`), a probe (`if (!api)`), a `const` alias, a return of a
 * function that returns the API, or the argument of an API parameter. Anywhere else it escapes.
 */
function isApiSink(node: ts.Node, ctx: AccessorContext): boolean {
  const { outer, child } = climbWrappers(node);
  if (!outer) return false;
  if (ts.isPropertyAccessExpression(outer) && outer.expression === child) return true;
  if (isTruthinessPosition(child)) return true;
  if (ts.isVariableDeclaration(outer)) {
    return outer.initializer === child && ts.isIdentifier(outer.name) && isConstDeclaration(outer);
  }
  if (ts.isReturnStatement(outer)) {
    const fn = enclosingFunction(outer);
    return !!fn && (ctx.api.returns.has(fn) || isAccessorDefinition(fn));
  }
  if (ts.isArrowFunction(outer)) {
    return outer.body === child && (ctx.api.returns.has(outer) || isAccessorDefinition(outer));
  }
  if (ts.isConditionalExpression(outer)) {
    // Only a choice that is the API on every branch is followed: `c ? xdeck().entity : other` is not.
    return outer.condition !== child && apiRoots(outer, ctx) !== null && isApiSink(outer, ctx);
  }
  if (ts.isCallExpression(outer) && outer.expression !== child) {
    const index = outer.arguments.indexOf(child as ts.Expression);
    if (index < 0 || outer.arguments.slice(0, index).some(ts.isSpreadElement)) return false;
    const targets = callTargets(outer, ctx);
    return (
      targets.length > 0 &&
      targets.every((target) => {
        const param = target.parameters[index];
        return !!param && ctx.api.params.has(param);
      })
    );
  }
  return false;
}

/** The API itself — `xdeck()` or `globalThis.xdeck` — escapes as a value unless it stays where the analyzer reads it. */
function inspectBareAccessor(
  node: ts.Expression,
  sf: ts.SourceFile,
  unresolvable: UnresolvableUsage[],
  accessor: AccessorContext
): void {
  if (isApiSink(node, accessor)) return;
  const { outer } = climbWrappers(node);
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const shown = isAccessorCall(node) ? 'xdeck()' : oneLine(node.getText(sf));
  pushUnresolvable(
    {
      file: sf.fileName,
      line: line + 1,
      expression: oneLine((outer ?? node).getText(sf)),
      reason: `bare \`${shown}\` used as a value — call \`${shown}.<domain>.<method>(...)\`, or bind it to a \`const\` that is only called through, so the analyzer can see what is invoked`
    },
    node,
    sf,
    unresolvable,
    accessor
  );
}

/**
 * A bare `xdeck` that is neither the head of a chain (judged with the chain) nor called (the
 * accessor). Naming the injected global — or a `const` of it — it may stay where the analyzer
 * reads it, like `xdeck()`. Naming the package's accessor function, it is called, probed or
 * exported under its own name only: passed, stored, aliased or default-exported, whatever
 * receives it can reach the API under a name the walk does not know.
 */
function inspectXdeckName(
  id: ts.Identifier,
  sf: ts.SourceFile,
  unresolvable: UnresolvableUsage[],
  accessor: AccessorContext
): void {
  if (!isValueReference(id)) return;
  if (ts.isExportSpecifier(id.parent)) return; // `export { xdeck }` — a rename is judged at the specifier
  const { outer, child } = climbWrappers(id);
  if (outer && (ts.isPropertyAccessExpression(outer) || ts.isCallExpression(outer)) && outer.expression === child) {
    return;
  }
  if (isTruthinessPosition(child)) return;
  const isApi = apiRoots(id, accessor) !== null;
  if (isApi && isApiSink(id, accessor)) return;
  const { line } = sf.getLineAndCharacterOfPosition(id.getStart(sf));
  pushUnresolvable(
    {
      file: sf.fileName,
      line: line + 1,
      expression: oneLine((outer ?? id).getText(sf)),
      reason: isApi
        ? 'the runtime global `xdeck` used as a value — call `xdeck.<domain>.<method>(...)`, or bind it to a `const` that is only called through, so the analyzer can see what is invoked'
        : 'the runtime accessor `xdeck` used as a value — call it where it is named (`xdeck().<domain>.<method>(...)`); passed, stored, aliased or default-exported, the analyzer cannot follow what is invoked through it'
    },
    id,
    sf,
    unresolvable,
    accessor
  );
}

/** `import { xdeck as rt }`, `export { xdeck as rt }`: the walk knows the accessor by its name, so `rt()` would pass unread. */
function inspectRenamedAccessor(
  spec: ts.ImportSpecifier | ts.ExportSpecifier,
  sf: ts.SourceFile,
  unresolvable: UnresolvableUsage[],
  accessor: AccessorContext
): void {
  if (spec.propertyName?.text !== 'xdeck' || spec.name.text === 'xdeck') return;
  if (spec.isTypeOnly || spec.parent.parent.isTypeOnly) return;
  const { line } = sf.getLineAndCharacterOfPosition(spec.getStart(sf));
  pushUnresolvable(
    {
      file: sf.fileName,
      line: line + 1,
      expression: oneLine(spec.getText(sf)),
      reason: `the runtime accessor \`xdeck\` renamed to \`${spec.name.text}\` — import and export it as \`xdeck\`; the analyzer knows the accessor by its name`
    },
    spec,
    sf,
    unresolvable,
    accessor,
    false
  );
}

/** `ns.xdeck()` through `import * as ns`: the walk knows the accessor by its name, not through a namespace. */
function inspectNamespacedAccessor(
  access: ts.PropertyAccessExpression,
  sf: ts.SourceFile,
  unresolvable: UnresolvableUsage[],
  accessor: AccessorContext
): void {
  if (access.name.text !== 'xdeck') return;
  const head = stripWrappers(access.expression);
  if (!ts.isIdentifier(head) || !accessor.unit.namespaces.has(head.text)) return;
  const binding = findBinding(head);
  if (!binding || !ts.isImportDeclaration(binding)) return;
  const { line } = sf.getLineAndCharacterOfPosition(access.getStart(sf));
  pushUnresolvable(
    {
      file: sf.fileName,
      line: line + 1,
      expression: oneLine(access.getText(sf)),
      reason: `the runtime accessor reached through the namespace import \`${head.text}\` — import it by name (\`import { xdeck } from …\`); the analyzer knows the accessor by its name`
    },
    access,
    sf,
    unresolvable,
    accessor,
    false
  );
}

/** An alias passed, returned, stored or spread escapes the analysis — whatever receives it can call anything. */
function inspectAliasReference(
  id: ts.Identifier,
  sf: ts.SourceFile,
  unresolvable: UnresolvableUsage[],
  accessor: AccessorContext
): void {
  const parent = id.parent;
  if (!parent) return;
  // Not a reference to a binding: a property name, a declaration's own name, an object key.
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return;
  if (ts.isVariableDeclaration(parent) && parent.name === id) return;
  if (ts.isParameter(parent) && parent.name === id) return;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent)) &&
    parent.name === id
  ) {
    return;
  }
  if (ts.isTypeQueryNode(parent)) return; // `typeof api` in a type position
  // A call through the alias — `api.read(…)` — is read where the chain is inspected.
  const { outer, child } = climbWrappers(id);
  if (outer && ts.isPropertyAccessExpression(outer) && outer.expression === child) return;
  if (!apiRoots(id, accessor)) return; // the same name, bound to something else here
  if (isApiSink(id, accessor)) return;
  const { line } = sf.getLineAndCharacterOfPosition(id.getStart(sf));
  pushUnresolvable(
    {
      file: sf.fileName,
      line: line + 1,
      expression: oneLine((outer ?? id).getText(sf)),
      reason: `\`${id.text}\` (an alias of the runtime API) escapes as a value — call through it (\`${id.text}.<method>(...)\`) where it is bound, so the analyzer can see what is invoked`
    },
    id,
    sf,
    unresolvable,
    accessor
  );
}

/** A call to a function that returns the API is the API: it escapes unless it stays where the analyzer reads it. */
function inspectApiCall(
  call: ts.CallExpression,
  sf: ts.SourceFile,
  unresolvable: UnresolvableUsage[],
  accessor: AccessorContext
): void {
  if (accessor.api.returns.size === 0 || !apiRoots(call, accessor) || isApiSink(call, accessor)) return;
  const { outer } = climbWrappers(call);
  const { line } = sf.getLineAndCharacterOfPosition(call.getStart(sf));
  const callee = oneLine(stripWrappers(call.expression).getText(sf));
  pushUnresolvable(
    {
      file: sf.fileName,
      line: line + 1,
      expression: oneLine((outer ?? call).getText(sf)),
      reason: `\`${callee}()\` returns the runtime API and escapes as a value — call through it (\`${callee}().<method>(...)\`) or bind it to a \`const\` that is only called through, so the analyzer can see what is invoked`
    },
    call,
    sf,
    unresolvable,
    accessor
  );
}

// ─── accessor form: values the analyzer can still know ───────────────

/** The `argKey` value in a call's first-argument object literal (`{ entityName }` or `{ entityName: x }`). */
function resourceArgExpression(call: ts.CallExpression, argKey: string): ts.Expression | null {
  const first = call.arguments[0];
  if (!first || !ts.isObjectLiteralExpression(stripWrappers(first))) return null;
  for (const prop of (stripWrappers(first) as ts.ObjectLiteralExpression).properties) {
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === argKey) return prop.name;
    if (ts.isPropertyAssignment(prop) && propName(prop.name) === argKey) return prop.initializer;
  }
  return null;
}

function propName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return null;
}

function isConstDeclaration(decl: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(decl.parent) && (decl.parent.flags & ts.NodeFlags.Const) !== 0;
}

function forOfOf(decl: ts.VariableDeclaration): ts.ForOfStatement | null {
  const list = decl.parent;
  return ts.isVariableDeclarationList(list) && ts.isForOfStatement(list.parent) && list.parent.initializer === list
    ? list.parent
    : null;
}

/**
 * Every string a resource-id expression can be, when the source says so: a literal; a
 * choice between literals (`admissionId ? 'Admission' : 'Encounter'`); a `const` bound to
 * either; or a column of a const table iterated by `for … of` (`table.entityName`,
 * `for (const { entityName } of SEED_TABLES)`). `null` when any value is unknown.
 */
function literalValues(expr: ts.Expression, depth = 0): string[] | null {
  if (depth > 6) return null;
  const e = stripWrappers(expr);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isConditionalExpression(e)) {
    const a = literalValues(e.whenTrue, depth + 1);
    const b = literalValues(e.whenFalse, depth + 1);
    return a && b ? [...new Set([...a, ...b])] : null;
  }
  if (ts.isIdentifier(e)) {
    const binding = findBinding(e);
    if (!binding || !ts.isVariableDeclaration(binding) || !isConstDeclaration(binding)) return null;
    const loop = forOfOf(binding);
    if (loop) {
      // `for (const { entityName } of TABLE)` — the destructured column.
      if (!ts.isObjectBindingPattern(binding.name)) return null;
      const el = binding.name.elements.find((x) => ts.isIdentifier(x.name) && x.name.text === e.text);
      if (!el) return null;
      const column = el.propertyName ? propName(el.propertyName) : e.text;
      return column ? tableColumn(loop.expression, column, depth + 1) : null;
    }
    return binding.initializer ? literalValues(binding.initializer, depth + 1) : null;
  }
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
    // `for (const table of SEED_TABLES) … table.entityName`
    const binding = findBinding(e.expression);
    if (!binding || !ts.isVariableDeclaration(binding) || !ts.isIdentifier(binding.name)) return null;
    const loop = forOfOf(binding);
    return loop ? tableColumn(loop.expression, e.name.text, depth + 1) : null;
  }
  return null;
}

/** One property of every row of a const array of object literals; `null` if any row lacks a known value. */
function tableColumn(iterable: ts.Expression, column: string, depth: number): string[] | null {
  let table = stripWrappers(iterable);
  if (ts.isIdentifier(table)) {
    const binding = findBinding(table);
    if (!binding || !ts.isVariableDeclaration(binding) || !isConstDeclaration(binding) || !binding.initializer)
      return null;
    table = stripWrappers(binding.initializer);
  }
  if (!ts.isArrayLiteralExpression(table) || table.elements.length === 0) return null;
  const out = new Set<string>();
  for (const element of table.elements) {
    const row = stripWrappers(element);
    if (!ts.isObjectLiteralExpression(row)) return null;
    const prop = row.properties.find(
      (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && propName(p.name) === column
    );
    const values = prop ? literalValues(prop.initializer, depth + 1) : null;
    if (!values) return null;
    for (const v of values) out.add(v);
  }
  return [...out];
}

// ─── accessor form: forwarding helpers ───────────────────────────────

/** When `expr` is a plain parameter of an indexed function: that function and the parameter's position. */
function forwardedParameter(
  expr: ts.Expression,
  fns: FunctionIndex
): { fn: ts.SignatureDeclaration; index: number } | null {
  const e = stripWrappers(expr);
  if (!ts.isIdentifier(e)) return null;
  const binding = findBinding(e);
  if (!binding || !ts.isParameter(binding) || !ts.isIdentifier(binding.name)) return null;
  const fn = binding.parent;
  // An anonymous callback (`rows.map((name) => …)`) is not indexed: whoever calls it is unknown.
  return ts.isFunctionLike(fn) && fns.all.has(fn) ? { fn, index: fn.parameters.indexOf(binding) } : null;
}

function isForwardedByHelper(expr: ts.Expression, method: string, ctx: AccessorContext): boolean {
  const fwd = forwardedParameter(expr, ctx.fns);
  return !!fwd && (ctx.helpers.get(fwd.fn) ?? []).some((h) => h.paramIndex === fwd.index && h.method === method);
}

/**
 * Index the package's forwarding helpers: first the functions that pass a parameter
 * straight into a parameterized call, then — to a fixpoint — the functions that pass
 * a parameter on to one of those. A helper is kept only where its callers are all known.
 */
function buildHelperIndex(
  contexts: AccessorContext[],
  fns: FunctionIndex
): Map<ts.SignatureDeclaration, ForwardingHelper[]> {
  const helpers = new Map<ts.SignatureDeclaration, ForwardingHelper[]>();
  const add = (fn: ts.SignatureDeclaration, entry: ForwardingHelper): boolean => {
    const list = helpers.get(fn) ?? [];
    if (list.some((h) => h.paramIndex === entry.paramIndex && h.method === entry.method)) return false;
    list.push(entry);
    helpers.set(fn, list);
    return true;
  };
  for (const ctx of contexts) {
    walkTree(ctx.unit.sf, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = stripWrappers(node.expression);
      if (!ts.isPropertyAccessExpression(callee)) return;
      for (const members of resolveAccessorChain(callee, ctx) ?? []) {
        if (members.length !== 2) continue;
        const method = `${members[0]}.${members[1]}`;
        const mapping = lookupXdeckMethod(method);
        if (!mapping || mapping.kind !== 'parameterized') continue;
        const arg = resourceArgExpression(node, mapping.argKey);
        const fwd = arg ? forwardedParameter(arg, fns) : null;
        if (fwd) add(fwd.fn, { paramIndex: fwd.index, method });
      }
    });
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [fn, calls] of fns.calls) {
      for (const h of [...(helpers.get(fn) ?? [])]) {
        for (const call of calls) {
          const arg = call.arguments[h.paramIndex];
          const fwd = arg ? forwardedParameter(arg, fns) : null;
          if (fwd && add(fwd.fn, { paramIndex: fwd.index, method: h.method })) changed = true;
        }
      }
    }
  }
  for (const fn of [...helpers.keys()]) {
    // Reached some other way too (passed, stored, re-exported): its arguments cannot all be read.
    if (fns.open.has(fn)) helpers.delete(fn);
    // A method nothing in the package calls may be an entry point the platform calls, with
    // parameters from a request: what it forwards is unknown, so its own sites stay findings.
    // A plain function nothing calls is dead code — no value reaches its parameter — and is kept.
    else if (!fns.calls.has(fn) && ts.isMethodDeclaration(fn)) helpers.delete(fn);
  }
  return helpers;
}

/** A call to a forwarding helper: a known argument is the capability; an unknown one is a finding. */
function inspectHelperCall(
  call: ts.CallExpression,
  sf: ts.SourceFile,
  used: Map<string, CapabilityUsageSite[]>,
  unresolvable: UnresolvableUsage[],
  accessor: AccessorContext
): void {
  const targets = callTargets(call, accessor).filter((target) => accessor.helpers.has(target));
  if (targets.length === 0) return;
  const callee = stripWrappers(call.expression);
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.getText(sf);
  const { line } = sf.getLineAndCharacterOfPosition(call.getStart(sf));
  const recorded = new Set<string>();
  const flagged = new Set<number>();
  for (const target of targets) {
    for (const h of accessor.helpers.get(target) ?? []) {
      const arg = call.arguments[h.paramIndex];
      const literals = arg ? literalValues(arg) : null;
      if (literals) {
        for (const value of literals) {
          const cap = capabilityForMethodCall(h.method, value);
          if (cap && !recorded.has(cap)) {
            recorded.add(cap);
            recordUse(used, cap, sf.fileName, line + 1);
          }
        }
        continue;
      }
      if (arg && isForwardedByHelper(arg, h.method, accessor)) continue;
      if (flagged.has(h.paramIndex)) continue;
      flagged.add(h.paramIndex);
      pushUnresolvable(
        {
          file: sf.fileName,
          line: line + 1,
          expression: oneLine(call.getText(sf)),
          reason: `\`${name}(...)\` passes argument ${h.paramIndex + 1} on as the resource of \`xdeck.${h.method}(...)\` — pass a literal (or a const of literals) so the analyzer can compute the capability`
        },
        call,
        sf,
        unresolvable,
        accessor
      );
    }
  }
}

function isStatementList(node: ts.Node): boolean {
  return (
    ts.isBlock(node) ||
    ts.isSourceFile(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node)
  );
}

/**
 * The reason on an `xdeck-capability-dynamic:` marker directly above the finding's statement,
 * or above a statement enclosing it in the same function (one marker over a `switch` covers its
 * cases); `null` when there is none or it says too little to be a reason.
 */
function dynamicMarkerNote(at: ts.Node, sf: ts.SourceFile): string | null {
  for (let current: ts.Node = at; current.parent; current = current.parent) {
    if (current !== at && ts.isFunctionLike(current)) return null;
    if (!isStatementList(current.parent)) continue;
    for (const range of ts.getLeadingCommentRanges(sf.text, current.getFullStart()) ?? []) {
      const match = /xdeck-capability-dynamic:[ \t]*([^\n]*)/.exec(sf.text.slice(range.pos, range.end));
      if (!match) continue;
      const note = match[1].replace(/\*\/\s*$/, '').trim();
      if (note.length >= DYNAMIC_MARKER_MIN_NOTE) return note;
    }
  }
  return null;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

// ─── helpers (exported for spec testing) ─────────────────────────────

/**
 * Extract a literal-string value of the named property from the call's
 * first argument when shaped `({ <argKey>: 'literal' })`. Non-object,
 * non-literal, or missing → null (caller treats as unresolvable).
 */
export function extractLiteralArg(call: ts.CallExpression, argKey: string): string | null {
  const first = call.arguments[0];
  if (!first || !ts.isObjectLiteralExpression(first)) return null;
  for (const prop of first.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = prop.name;
    const propKey = ts.isIdentifier(name) ? name.text : ts.isStringLiteral(name) ? name.text : null;
    if (propKey !== argKey) continue;
    const value = prop.initializer;
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
    return null;
  }
  return null;
}
