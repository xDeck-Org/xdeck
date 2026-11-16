/**
 * §9.91.2 — Field-level ABAC primitive (purpose-of-use-resolved minimum-necessary
 * field projection). The pure, sandbox-agnostic, DB-agnostic core; lives beside
 * {@link RuntimeGuard} for the same reason — the host wires the data-backed
 * resolver, the library owns the decision shape + the projection.
 *
 * **The gap it closes.** §9.50 `entity:read:<Entity>` is entity-TYPE membership
 * only — a clinician, billing clerk, and auditor all read the *same columns* via
 * the same grant. The per-tenant Postgres DB is the only access boundary; there
 * is no intra-row field masking. SMART-on-FHIR scopes confirm the ceiling
 * (resource-TYPE CRUD, no field hiding). This is the minimum-necessary layer
 * *above* the tenant boundary — never a substitute for it.
 *
 * **PR-1 ships the primitive only (no wiring).** Mirroring §9.91.1 PR-1, this is
 * pure vocabulary + a pure projection + a static resolver + tests. PR-2 plumbs
 * the CARRIER onto the read path and consumes {@link projectVisibleFields} in
 * `EntityCapabilityService.readWith`; PR-3 adds row-scope WHERE injection.
 *
 * **Two acceptance criteria pinned into the type design (adversarial-verify):**
 *
 *  1. **The carrier is the tenant-CLINICIAN session/request context — NOT the
 *     §9.71 step-up token.** §9.71 step-up is for *builders* debugging; a routine
 *     clinician read carries purpose+role on the tenant user's session. PR-1
 *     models that as {@link FieldAccessQuery} (`actorRole` + `purpose`).
 *     PLUMBED (§9.94 B5.c + §9.91.8 PR-4a): the sandbox host derives the
 *     carrier from the JWT-verified `GuardContext.actor` — `actorRole` when
 *     the actor holds exactly ONE role (multi-role degrades to null until
 *     union semantics land; a roles array has no meaningful order), `purpose`
 *     null until a per-call assertion surface exists. The decision still
 *     degrades *open* for unclassified entities and *closed* (deny-by-default)
 *     for classified ones — null carrier fields always fail closed.
 *
 *  2. **Purpose-of-use is a POLICY resolved via a port, NOT a bare string switch
 *     scattered across call sites.** The purpose IDENTIFIER is an opaque id; the
 *     mask/consent/retention BEHAVIOUR is owned by the {@link FieldAccessPolicyResolver}
 *     implementation's backing store — SHIPPED as the persistent purpose-policy
 *     relation behind `FieldAccessRegistryService`, production-bound via
 *     `FIELD_ACCESS_RESOLVER_TOKEN` (this line said "the relation the forcing
 *     vertical configures, TODO(§9.91.x)" until 2026-08-27). Adding a
 *     purpose/role/field-class is then a data edit there, never a call-site
 *     code change.
 */

/**
 * Opaque purpose-of-use identifier carried on the tenant session and resolved to
 * a policy by a {@link FieldAccessPolicyResolver}. Deliberately a bare string,
 * NOT a union enum: the closed set of purposes (treatment / billing / operations
 * / research / public-health / hiu-share / legal …) is owned by the resolver's
 * backing relation so adding one is a data edit, not a `libs/` type change
 * (criterion 2 — "a relation, not a flat string claim"). `null` = no purpose
 * asserted (an unscoped/legacy read).
 */
export type PurposeOfUseId = string;

/**
 * §9.91.9 PR-4 — the consent-required purpose FLOOR. These purposes may NEVER
 * disclose rows without a valid consent artifact — the floor is compiled-in so
 * no empty/misconfigured relation can fail it OPEN (the §9.91.6 statutory-floor
 * posture). The §9.91.9 slice itself names exactly these two (Art 9(2)(h):
 * clinical-care purposes stay consent-free; research and network-share do not).
 * A future third consent-required purpose (e.g. insurance-TPA) adds a
 * persistent ADD-ONLY relation on the §9.91.6 registry pattern — the floor can
 * grow from data, never shrink.
 */
export const CONSENT_REQUIRED_PURPOSES_FLOOR: readonly PurposeOfUseId[] = ['research', 'hiu-share'];

/** Whether an asserted purpose is consent-gated ({@link CONSENT_REQUIRED_PURPOSES_FLOOR}). */
export function isConsentRequiredPurpose(purpose: PurposeOfUseId | null | undefined): boolean {
  return purpose != null && CONSENT_REQUIRED_PURPOSES_FLOOR.includes(purpose);
}

/**
 * What an actor may see of one entity type, for one (role, purpose). `'all'` is
 * the explicit no-masking decision (non-classified entity, or a fully-authorized
 * role+purpose) — distinct from an empty set, which means "this actor sees no
 * columns of this entity" (deny). Keeping `'all'` a distinct sentinel (vs. the
 * full column list) means the projection can short-circuit with zero work on the
 * overwhelmingly common unmasked path.
 */
export interface FieldAccessDecision {
  visibleFields: ReadonlySet<string> | 'all';
}

/**
 * The tenant-clinician SESSION carrier (criterion 1): the acting actor's role +
 * the purpose they assert for this read. DELIBERATELY a standalone type, threaded
 * alongside — never folded into — the package-scoped `GuardContext` (§9.50) and
 * distinct from the §9.71 builder step-up token. A `readWith` caller passes this
 * from the tenant user's request/session.
 *
 * 2026-08-27 STALENESS CORRECTION — this docblock said the sandbox-host plumbing
 * was `TODO(§9.91.2 PR-2 / Slice 5a)`; it SHIPPED. The host's `entity.read`
 * handler passes `actorReadCtx(ctx)` (xdeck-host.service.ts), which carries the
 * order-independent single role, the §9.91.8 union-across-roles `actorRoles`,
 * the dispatch-validated `purpose`, `actorId`, and the §9.150 `principalKind`.
 * The degrade contract below still holds for callers that OMIT the carrier:
 * `{null, null}` fails CLOSED for classified entities and is a no-op for
 * unclassified ones.
 */
export interface ReadAccessContext {
  /** The acting tenant user's role. `null` = unknown actor (degrade closed for classified entities). */
  actorRole: string | null;
  /**
   * §9.91.8 PR-4b — ALL the actor's roles, for union-across-roles field
   * resolution: a multi-role user sees the UNION of what each role may see
   * (the platform's RBAC permission-union applied to field-ABAC; each role's
   * grant is individually legitimate, and a role matching no rule contributes
   * NOTHING — per-role fail-closed is preserved). When absent, resolution
   * falls back to the single `actorRole`. Row-scope unions too (§9.91.8
   * row-union): per-hat scopes become OR-alternatives, each branch carrying
   * one hat's COMPLETE floor — see the row-scope module.
   */
  actorRoles?: readonly string[] | null;
  /** The asserted purpose-of-use. `null` = no purpose asserted. */
  purpose: PurposeOfUseId | null;
  /**
   * §9.91.2 PR-3 — the acting user's id, the most common row-scope key (e.g.
   * "own-panel patients" ⇒ `WHERE assignedClinicianId = actorId`). Optional;
   * `null`/absent ⇒ a row-scope rule that references it fails CLOSED (deny) for a
   * classified entity rather than returning the unscoped set.
   */
  actorId?: string | null;
  /**
   * §9.91.2 PR-3 — additional session attributes a row-scope rule may key on
   * (e.g. `outletId`, `departmentId` — the generalized §9.82 outlet-RBAC need).
   * A referenced attribute that is absent also fails CLOSED.
   */
  actorAttributes?: Readonly<Record<string, unknown>>;
  /**
   * §9.91.9 PR-4 — the consent artifact this read runs UNDER, when the asserted
   * purpose is consent-required ({@link isConsentRequiredPurpose}). The egress
   * gate resolves it (granted, in-window, this deck) into a row-scope floor
   * pinning rows to the consented patient; a consent-required purpose asserted
   * WITHOUT an artifact fails closed to zero rows. Irrelevant (ignored) for
   * clinical-care purposes — consent is never the sole gate for treatment
   * (Art 9(2)(h)).
   */
  consentArtifactId?: string | null;
  /**
   * §9.150 — WHICH KIND of principal this is, SUPPLIED by the ingress rather than
   * inferred downstream. The record-scope write floor must tell a tenant STAFF member
   * (floored to their granted scopes) from a DEVICE (authorized by the §9.50 capability
   * vocabulary, but floored like a scopeless user per the dispatcher's own §9.76 note)
   * from a CONSUMER / guest-route principal (authorized at the route, and correctly
   * unconstrained). Its only available signal was role-EMPTINESS, which is not a
   * discriminator at all: an ingress that merely failed to populate roles made a staff
   * member indistinguishable from a consumer, and that is exactly how the package-route
   * door came to bypass the floor.
   *
   * Absent = unknown. The floor treats unknown conservatively rather than as a licence.
   *
   * The union deliberately MATCHES `XDeckActor.principalKind` and extends it with the
   * two classes only the host names (`consumer`, `system`). Two principal vocabularies
   * that disagree is how a class ends up handled on one door and not the other, so any
   * new kind is added HERE and there together.
   */
  principalKind?: 'user' | 'device' | 'step_up' | 'consumer' | 'system' | 'api_key' | 'integrator' | null;
}

/**
 * The read context a field-access decision is made against — the {@link
 * ReadAccessContext} carrier plus the entity type being read. Carried from the
 * tenant-clinician session, distinct from the package-scoped `GuardContext`.
 */
export interface FieldAccessQuery extends ReadAccessContext {
  /** The entity type being read (e.g. `Encounter`, `Patient`). */
  entityType: string;
}

/**
 * Port the host implements to answer "which columns may this actor see?". The
 * IMPLEMENTATION owns the (entityType × role × purpose) → field-set RELATION —
 * the library only defines the question + the answer shape. Production wires a
 * data-backed resolver (PR-2); tests + the unclassified-entity default use
 * {@link StaticFieldAccessPolicyResolver}.
 */
export interface FieldAccessPolicyResolver {
  resolveVisibleFields(query: FieldAccessQuery): FieldAccessDecision;
}

/**
 * Per-entity field-access policy the {@link StaticFieldAccessPolicyResolver} is
 * seeded with. A `classified` entity opts INTO masking; an entity absent from
 * the resolver's map is `'all'` (unmasked) — the migration-safe default that
 * mirrors §9.91.1's opt-in PHI classification (a brand-new non-clinical read is
 * never silently truncated; adding a classification is the act that turns
 * enforcement on).
 */
export interface StaticEntityFieldPolicy {
  /**
   * Visible-field set keyed by `"<role>|<purpose>"`, then `"<role>|*"` (any
   * purpose), then `"*|<purpose>"`, then `"*|*"` (the entity's baseline). The
   * resolver picks the most specific match. A matched value of `'all'` lifts the
   * mask for that combination.
   *
   * **`|` is the composite-key delimiter** — a `role`/`purpose` id MUST NOT
   * contain `|`, or its composite key would be ambiguous. This constraint is
   * local to the in-memory static resolver only: the PR-2 persistent
   * purpose-policy RELATION keys on `(entityType, role, purpose)` COLUMNS, not a
   * joined string, so the delimiter never reaches a stored/wire format. (The
   * lookup is own-property-guarded — a prototype-polluted key cannot satisfy a
   * classified-entity rule; see {@link StaticFieldAccessPolicyResolver}.)
   */
  rules: Record<string, ReadonlySet<string> | 'all'>;
}

/**
 * Pure, in-memory {@link FieldAccessPolicyResolver}. Deterministic and DB-free —
 * the same query always yields the same decision (Reliability: idempotent, no
 * retry surface). Resolution order, most-specific first:
 *
 *   `<role>|<purpose>`  →  `<role>|*`  →  `*|<purpose>`  →  `*|*`
 *
 * **Defaults (criterion 1 degrade behaviour):**
 *  - entity NOT in the map  → `'all'` (unmasked; opt-in classification).
 *  - entity IS in the map but no rule matches → **deny** (empty set). A
 *    classified clinical entity with an unrecognised (role, purpose) — including
 *    the `null/null` "no carrier yet" case — must NOT leak; it fails closed to
 *    no columns until the carrier + a matching rule land in PR-2.
 *
 * **Two fail-closed hardenings (adversarial-verify, `wf_2b5f8caa`):**
 *  - **Own-property lookups only.** A rule key is honoured only when it is the
 *    policy object's OWN property (`hasOwnProperty`), never an inherited one. A
 *    prototype-polluted key shaped like a lookup key (e.g.
 *    `Object.prototype['*|*'] = 'all'`) would otherwise satisfy a classified
 *    entity's miss and turn fail-closed into fail-OPEN. `rules` is plain
 *    JSON-shaped config (a classic pollution sink), so the gate must not assume a
 *    clean prototype.
 *  - **No shared mutable sentinel.** Every deny returns a FRESH empty `Set`, and
 *    a matched set is returned as a defensive COPY — a consumer that mutates a
 *    returned decision (`.add('diagnosis')`) can never poison the deny path or a
 *    policy's own set for other reads. Only `'all'` (an immutable string) is a
 *    shared singleton, and it is the zero-copy hot path.
 */
export class StaticFieldAccessPolicyResolver implements FieldAccessPolicyResolver {
  private static readonly ALLOW_ALL: FieldAccessDecision = { visibleFields: 'all' };

  constructor(private readonly policies: ReadonlyMap<string, StaticEntityFieldPolicy>) {}

  /** Internal miss sentinel — never handed out (callers copy into a fresh union set). */
  private static readonly NO_MATCH: ReadonlySet<string> = Object.freeze(new Set<string>()) as ReadonlySet<string>;

  resolveVisibleFields(query: FieldAccessQuery): FieldAccessDecision {
    const policy = this.policies.get(query.entityType);
    // Unclassified entity → unmasked (migration-safe, matches §9.91.1 opt-in).
    if (!policy) return StaticFieldAccessPolicyResolver.ALLOW_ALL;

    const purpose = query.purpose ?? '*';
    // §9.91.8 PR-4b — union-across-roles: resolve each of the actor's roles
    // independently and UNION the grants (RBAC permission-union applied to
    // field-ABAC). A role matching no rule contributes NOTHING (per-role
    // fail-closed preserved); any role resolving 'all' lifts the mask. With
    // no `actorRoles`, the single `actorRole` path is byte-identical to the
    // pre-PR-4b behaviour (null → '*'-keyed baseline rules only).
    const roles: Array<string | null> = query.actorRoles?.length ? [...new Set(query.actorRoles)] : [query.actorRole];

    // Fresh union set every call — the no-shared-mutable-sentinel hardening
    // holds by construction (nothing from the policy's own sets is aliased).
    const union = new Set<string>();
    for (const roleValue of roles) {
      const single = this.resolveForRole(policy, roleValue ?? '*', purpose);
      if (single === 'all') return StaticFieldAccessPolicyResolver.ALLOW_ALL;
      for (const field of single) union.add(field);
    }
    // Empty union = deny (classified entity, nothing matched any role) — the
    // same fail-closed shape as before, still a fresh Set.
    return { visibleFields: union };
  }

  /** Single-(role, purpose) resolution — the pre-PR-4b lookup, extracted. */
  private resolveForRole(policy: StaticEntityFieldPolicy, role: string, purpose: string): ReadonlySet<string> | 'all' {
    const keys = [`${role}|${purpose}`, `${role}|*`, `*|${purpose}`, '*|*'];
    for (const key of keys) {
      // OWN-property only — a prototype-polluted key must NOT satisfy a classified
      // lookup (else fail-closed silently becomes fail-open).
      if (!Object.prototype.hasOwnProperty.call(policy.rules, key)) continue;
      const match = policy.rules[key];
      // An own key explicitly set to undefined is treated as "no rule" so the
      // less-specific fallback keys still get their turn.
      if (match === undefined) continue;
      // A matched 'all' lifts the mask (immutable string singleton — safe to share).
      if (match === 'all') return 'all';
      // Internal reference only — resolveVisibleFields copies into a fresh set.
      return match;
    }
    return StaticFieldAccessPolicyResolver.NO_MATCH;
  }
}

/**
 * Apply a {@link FieldAccessDecision} to one row — the minimum-necessary
 * projection. Pure: returns a new object, never mutates the input.
 *
 *  - `'all'`        → the row unchanged (identity; zero-copy fast path).
 *  - a field set    → a shallow copy containing ONLY the visible keys present on
 *                     the row. A field the actor may not see is OMITTED (absent),
 *                     not nulled — an absent key is unambiguous; a `null` could be
 *                     read as "value is null" and is itself a (small) information
 *                     leak about which fields exist.
 */
export function projectVisibleFields<T extends Record<string, unknown>>(
  row: T,
  decision: FieldAccessDecision
): Partial<T> {
  if (decision.visibleFields === 'all') return row;
  const visible = decision.visibleFields;
  const out: Partial<T> = {};
  for (const key of Object.keys(row)) {
    if (visible.has(key)) out[key as keyof T] = row[key as keyof T];
  }
  return out;
}

/**
 * Convenience: project a whole result set. Equivalent to mapping
 * {@link projectVisibleFields}, with the same `'all'` zero-copy short-circuit so
 * the unmasked hot path (every non-clinical read) costs one comparison.
 */
export function projectRows<T extends Record<string, unknown>>(
  rows: readonly T[],
  decision: FieldAccessDecision
): Array<Partial<T>> {
  // Zero-copy: `T` is assignable to `Partial<T>`, so the array is already a valid
  // result; the cast only sheds the input's `readonly` for the declared return.
  if (decision.visibleFields === 'all') return rows as unknown as Array<Partial<T>>;
  return rows.map((row) => projectVisibleFields(row, decision));
}
