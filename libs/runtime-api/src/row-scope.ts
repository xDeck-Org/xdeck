/**
 * §9.91.2 PR-3 — Row-scope WHERE-injection primitive. The pure, sandbox-agnostic,
 * DB-agnostic core that turns an actor's session attributes into a row-level
 * predicate AND-combined with the caller's `where`, so a read returns only the
 * rows the actor is entitled to (own-panel clinician, own-outlet staff — the
 * generalized §9.82 outlet-RBAC need). Companion to {@link field-access} (field
 * masking): same {@link ReadAccessContext} carrier, distinct concern.
 *
 * **The hard rule: scope is a floor the caller can only NARROW, never WIDEN.**
 * The injected predicate's keys are spread LAST over the caller's `where`, so on
 * a key collision the scope wins (a package that tries `clinicianId = someoneElse`
 * is overridden to `clinicianId = me`). The caller's other keys further narrow.
 *
 * **Fail-closed.** A classified entity whose scope cannot be derived — a rule
 * references `actorId` but it is null, or an attribute that is absent — resolves
 * to `'none'`: the read returns ZERO rows (never the unscoped set). An
 * unclassified entity (no rule) resolves to `'all'` (no constraint), the
 * migration-safe opt-in default matching PR-1/PR-2.
 *
 * **PR-3 shipped the primitive + the wiring — and both former TODOs have since
 * landed** (wording corrected 2026-08-27): the persistent scope RELATION is
 * `RowScopeRegistryService`, production-bound via `ROW_SCOPE_RESOLVER_TOKEN`,
 * and the sandbox host plumbs the carrier (`entity.read` passes
 * `actorReadCtx(ctx)` — actorId, roles, purpose, principalKind — in
 * xdeck-host.service.ts).
 */

import type { PurposeOfUseId, ReadAccessContext } from './field-access';

/** A concrete row-scope predicate: column → required value, AND-combined. */
export type RowScopeConstraint = Record<string, unknown>;

/**
 * A row-scope decision.
 *  - `'all'`  → no row constraint (unclassified entity / fully-authorized).
 *  - `'none'` → deny ALL rows (fail-closed: a classified entity whose scope could
 *    not be derived). The caller returns an empty set WITHOUT querying.
 *  - a {@link RowScopeConstraint} → AND these column constraints onto the read.
 *  - a {@link RowScopeConstraint}[] → §9.91.8 row-union: OR-ALTERNATIVES, one per
 *    resolved actor role (a two-hat actor may see rows EITHER hat may see; each
 *    alternative is itself an AND, and the caller's `where` is distributed into
 *    every alternative so no branch escapes any hat's floor).
 */
export interface RowScopeDecision {
  scope: RowScopeConstraint | RowScopeConstraint[] | 'all' | 'none';
}

/** The context a row-scope decision is made against — the carrier + entity. */
export interface RowScopeQuery extends ReadAccessContext {
  entityType: string;
}

/**
 * Port the host implements to answer "which rows of this entity may this actor
 * see?". The IMPLEMENTATION owns the (entityType × role × purpose) → scope
 * RELATION + how it derives the concrete predicate from the actor's attributes.
 */
export interface RowScopePolicyResolver {
  resolveRowScope(query: RowScopeQuery): RowScopeDecision;
}

/**
 * How the {@link StaticRowScopePolicyResolver} builds one predicate column. The
 * value comes from the acting session — the actor's id, a named session
 * attribute, or a literal constant. A referenced source that is absent fails the
 * whole rule CLOSED.
 */
export type RowScopeColumnSource = { fromActorId: true } | { fromAttribute: string } | { value: unknown };

/**
 * A per-entity row-scope rule for the static resolver: the predicate columns to
 * build, or the literal `'all'`/`'none'` decisions.
 */
export type RowScopeRule = { columns: Record<string, RowScopeColumnSource> } | 'all' | 'none';

/**
 * Per-entity static row-scope policy. Rules keyed by the SAME most-specific
 * precedence as field-access: `<role>|<purpose>` → `<role>|*` → `*|<purpose>` →
 * `*|*`. An entity absent from the resolver's map is `'all'` (unscoped, opt-in).
 *
 * **`|` is the composite-key delimiter** (local to this in-memory resolver; the
 * persistent relation keys on columns). Lookup is own-property-guarded — a
 * prototype-polluted key cannot satisfy a classified-entity rule (same hardening
 * as {@link StaticFieldAccessPolicyResolver}, `wf_2b5f8caa`).
 */
export interface StaticEntityRowScopePolicy {
  rules: Record<string, RowScopeRule>;
}

/**
 * Pure, in-memory {@link RowScopePolicyResolver}. Deterministic + DB-free.
 *
 *  - entity NOT in the map → `'all'` (unscoped; opt-in classification).
 *  - matched rule `'all'`/`'none'` → returned verbatim.
 *  - matched `columns` rule → each column resolved from the actor context; if ANY
 *    referenced `actorId`/attribute is null/absent → `'none'` (fail-closed, never
 *    a partial-scope leak). An empty `columns` map also fails CLOSED (a rule that
 *    constrains nothing would be an unscoped read on a classified entity).
 *  - classified entity, NO matching rule → `'none'` (fail-closed).
 */
export class StaticRowScopePolicyResolver implements RowScopePolicyResolver {
  // FRESH decisions every call — never a shared sentinel. `RowScopeDecision.scope`
  // is a mutable property, so a single shared `{scope:'all'}`/`{scope:'none'}`
  // object handed across the library boundary could be reassigned by a consumer
  // (`decision.scope = 'all'`) and poison every future deny into a fail-OPEN. This
  // is the §9.91.2 PR-1 shared-mutable-sentinel lesson (`wf_2b5f8caa`) applied up
  // front. The cost is one tiny object per resolve — negligible.
  private static all(): RowScopeDecision {
    return { scope: 'all' };
  }
  private static none(): RowScopeDecision {
    return { scope: 'none' };
  }

  constructor(private readonly policies: ReadonlyMap<string, StaticEntityRowScopePolicy>) {}

  resolveRowScope(query: RowScopeQuery): RowScopeDecision {
    const policy = this.policies.get(query.entityType);
    if (!policy) return StaticRowScopePolicyResolver.all();

    // §9.91.8 row-union — resolve each of the actor's roles independently and
    // OR the resulting scopes (a two-hat actor sees rows EITHER hat may see):
    // any role resolving 'all' lifts the constraint; a 'none' role contributes
    // nothing; NO role deriving a scope stays 'none' (fail-closed preserved).
    // Without `actorRoles`, the single-`actorRole` path is byte-identical to
    // the pre-union behaviour.
    const roles: Array<string | null> = query.actorRoles?.length ? [...new Set(query.actorRoles)] : [query.actorRole];

    const alternatives: RowScopeConstraint[] = [];
    for (const roleValue of roles) {
      const single = this.resolveForRole(policy, roleValue ?? '*', query);
      if (single.scope === 'all') return StaticRowScopePolicyResolver.all();
      if (single.scope === 'none') continue;
      alternatives.push(single.scope as RowScopeConstraint);
    }
    if (alternatives.length === 0) return StaticRowScopePolicyResolver.none();
    if (alternatives.length === 1) return { scope: alternatives[0] };
    // Fresh array every call (no shared sentinel) — order carries no meaning
    // (OR alternatives admit the same row set regardless of role order).
    return { scope: alternatives };
  }

  /** Single-(role, purpose) resolution — the pre-union lookup, extracted. */
  private resolveForRole(policy: StaticEntityRowScopePolicy, role: string, query: RowScopeQuery): RowScopeDecision {
    const purpose = query.purpose ?? '*';
    const keys = [`${role}|${purpose}`, `${role}|*`, `*|${purpose}`, '*|*'];
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(policy.rules, key)) continue;
      const rule = policy.rules[key];
      if (rule === undefined) continue;
      if (rule === 'all') return StaticRowScopePolicyResolver.all();
      if (rule === 'none') return StaticRowScopePolicyResolver.none();
      return this.buildConstraint(rule.columns, query);
    }
    // Classified entity, no matching rule for THIS role → fail CLOSED.
    return StaticRowScopePolicyResolver.none();
  }

  /** Resolve each column from the actor context; any missing source ⇒ deny. */
  private buildConstraint(columns: Record<string, RowScopeColumnSource>, query: RowScopeQuery): RowScopeDecision {
    const out: RowScopeConstraint = {};
    let count = 0;
    // OWN-property only — a prototype-polluted column key cannot inject a constraint.
    for (const column of Object.keys(columns)) {
      if (!Object.prototype.hasOwnProperty.call(columns, column)) continue;
      const source = columns[column];
      let resolved: unknown;
      if ('fromActorId' in source) {
        if (query.actorId === null || query.actorId === undefined) return StaticRowScopePolicyResolver.none();
        resolved = query.actorId;
      } else if ('fromAttribute' in source) {
        const attr = query.actorAttributes?.[source.fromAttribute];
        if (attr === null || attr === undefined) return StaticRowScopePolicyResolver.none();
        resolved = attr;
      } else {
        resolved = source.value;
      }
      out[column] = resolved;
      count++;
    }
    // A rule that constrains nothing is an unscoped read on a classified entity.
    if (count === 0) return StaticRowScopePolicyResolver.none();
    return { scope: out };
  }
}

/**
 * AND-combine a row-scope constraint with the caller's `where`. The scope is the
 * FLOOR — its keys are applied LAST so they win on collision (the caller cannot
 * widen past its scope; it can only narrow on other columns).
 *
 *  - `scope === 'all'`     → the caller's `where` unchanged.
 *  - caller `where` is an OBJECT (AND of keys) → `{ ...where, ...scope }`.
 *  - caller `where` is an ARRAY (OR of branches) → scope ANDed into EVERY branch,
 *    `[{ ...A, ...scope }, ...]`, so no branch escapes the scope.
 *  - caller `where` undefined → the scope alone.
 *  - §9.91.8 row-union: scope is an ARRAY of alternatives (one per actor role) →
 *    the caller's `where` is distributed across EVERY alternative (a full cross
 *    product with OR caller-branches), each alternative spread LAST — so every
 *    resulting branch still carries one hat's complete floor and the caller can
 *    widen past none of them. The result is an OR (array) where; TypeORM's
 *    array-`where` gives it native OR semantics.
 *
 * `'none'` is NOT handled here — the caller (readWith) short-circuits to an empty
 * result without querying. Passing `'none'` throws (a misuse), so a deny can
 * never silently degrade to "no constraint".
 */
/**
 * §9.91.9 PR-4 — AND-compose TWO row-scope floors (e.g. the role/purpose scope
 * with the consent-derived patient pin) into one decision that is at least as
 * narrow as EACH input.
 *
 * The one thing this must never do is spread-merge a key collision: two floors
 * constraining the SAME column to DIFFERENT values is `col = A AND col = B` —
 * an impossible predicate admitting ZERO rows — while `{...a, ...b}` would keep
 * only `b`'s value, silently WIDENING past floor `a`. So a colliding
 * alternative is DROPPED (it admits nothing), and if every alternative drops,
 * the composition is `'none'`.
 *
 *  - either floor `'none'` → `'none'`;
 *  - either floor `'all'` → the other floor verbatim;
 *  - arrays (role-union alternatives) compose per-alternative — each surviving
 *    branch carries BOTH floors in full.
 */
export function composeRowScopeFloors(
  a: RowScopeConstraint | RowScopeConstraint[] | 'all' | 'none',
  b: RowScopeConstraint | RowScopeConstraint[] | 'all' | 'none'
): RowScopeConstraint | RowScopeConstraint[] | 'all' | 'none' {
  if (a === 'none' || b === 'none') return 'none';
  if (a === 'all') return b;
  if (b === 'all') return a;

  const aAlts = Array.isArray(a) ? a : [a];
  const bAlts = Array.isArray(b) ? b : [b];
  const out: RowScopeConstraint[] = [];
  for (const left of aAlts) {
    for (const right of bAlts) {
      let impossible = false;
      const merged: RowScopeConstraint = { ...left };
      for (const key of Object.keys(right)) {
        if (!Object.prototype.hasOwnProperty.call(right, key)) continue;
        if (Object.prototype.hasOwnProperty.call(merged, key) && merged[key] !== right[key]) {
          impossible = true;
          break;
        }
        merged[key] = right[key];
      }
      if (!impossible) out.push(merged);
    }
  }
  if (out.length === 0) return 'none';
  return out.length === 1 ? out[0] : out;
}

export function applyRowScope<W extends Record<string, unknown>>(
  callerWhere: W | W[] | undefined,
  scope: RowScopeConstraint | RowScopeConstraint[] | 'all'
): W | W[] | RowScopeConstraint | RowScopeConstraint[] | undefined {
  // `'all'` is a passthrough — it may return `undefined` (no caller where), which
  // the readWith caller handles (`if (scopedWhere !== undefined)`); the return
  // type reflects that honestly rather than hiding it behind a cast.
  if (scope === 'all') return callerWhere;

  const scopeAlternatives: RowScopeConstraint[] = Array.isArray(scope) ? scope : [scope];
  const callerBranches: Array<W | undefined> =
    callerWhere === undefined ? [undefined] : Array.isArray(callerWhere) ? callerWhere : [callerWhere];

  const branches: RowScopeConstraint[] = [];
  for (const caller of callerBranches) {
    for (const alternative of scopeAlternatives) {
      branches.push({ ...(caller ?? {}), ...alternative });
    }
  }
  return branches.length === 1 ? branches[0] : branches;
}
