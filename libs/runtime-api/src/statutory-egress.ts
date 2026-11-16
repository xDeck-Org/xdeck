/**
 * §9.91.6 PR-1 — Statutory-egress deny primitive (PCPNDT-class non-disclosure).
 * The pure, sandbox-agnostic, DB-agnostic core; lives beside
 * {@link StaticFieldAccessPolicyResolver} for the same reason — the host wires
 * the data-backed registry, the library owns the rule shape + the redaction.
 *
 * **What it is NOT: §9.91.2 field-ABAC.** Field-ABAC is a minimum-necessary
 * PREFERENCE — purpose-liftable, empty-seeded in prod, `'all'` fail-open for
 * unclassified entities, enforced only at `readWith`. A statutory
 * non-disclosure invariant (PCPNDT prenatal-sex prohibition) is the opposite
 * on every axis: NO role, NO purpose (not even treatment), NO consent lifts
 * it, and it must hold on EVERY egress sink. The two compose by
 * INTERSECTION — run the ABAC projection first, then this floor — so the
 * statutory deny holds even when the field-ABAC resolver is misconfigured,
 * absent, or answers `'all'`.
 *
 * **The API cannot express a carve-out on purpose.** {@link
 * StatutoryEgressDenyResolver} is keyed on the entity type ALONE — there is no
 * role, purpose, or consent parameter to pass, so a caller cannot even ask
 * for a lifted decision (rejected-alternative 2 of the slice trace, pinned
 * into the type design).
 *
 * **PR-1 ships the primitive only (no wiring)** — mirroring §9.91.2 PR-1.
 * PR-2 runs the floor inside `EntityCapabilityService.readWith` after the
 * ABAC projection (non-optional, fail-closed on PHI decks); PR-3 emits the
 * suppression audit ({@link RedactionResult.suppressions} is its payload);
 * PR-4 routes every other egress sink (storage-write, AI-context,
 * offline-sync, export) through {@link redactStatutoryFields}; PR-5 replaces
 * the static resolver with the persistent statute-registry relation.
 *
 * **Fail-closed hardenings carried forward (adversarial-verify `wf_2b5f8caa`):**
 *  - Lookups are `Map`-based — a prototype-polluted `Object.prototype` key can
 *    neither create nor satisfy a rule (no object-keyed lookup exists at all).
 *  - A malformed registry row THROWS at construction. Silently dropping a
 *    statutory rule would be a silent breach; a statutory registry that cannot
 *    be trusted must fail loud before any read is served.
 *  - Every decision hands out FRESH collections — mutating a returned set or
 *    map can never poison the registry or another read's decision.
 *  - Redaction never mutates or aliases an affected input row.
 */

/**
 * Opaque statute identifier owned by the registry relation (PR-5): adding a
 * statute is a data edit, never a `libs/` type change. Deliberately a bare
 * string, not a union enum — mirrors {@link PurposeOfUseId}'s reasoning.
 */
export type StatuteId = string;

/** The first statute the registry carries (PCPNDT Act — prenatal non-disclosure, India). */
export const PCPNDT_2003: StatuteId = 'pcpndt-2003';

/**
 * One statutory deny rule — the registry-relation row shape (PR-5 persists
 * exactly this): under `statuteId`, the `field` of `entityType` may never
 * egress within `jurisdiction`. No lift column EXISTS by design.
 */
export interface StatutoryDenyRule {
  statuteId: StatuteId;
  entityType: string;
  field: string;
  /** Jurisdiction the statute binds (e.g. 'IN') — door-opens non-India decks without re-coding. */
  jurisdiction: string;
}

/**
 * The answer to "which fields of this entity type are statutorily denied?".
 * `statuteByField` names the statute behind each denial — the §9.91.1 audit
 * (PR-3) records suppressions per statute id, so the decision carries the
 * attribution rather than making the audit re-derive it.
 */
export interface StatutoryEgressDecision {
  deniedFields: ReadonlySet<string>;
  statuteByField: ReadonlyMap<string, StatuteId>;
}

/**
 * Port the host implements to answer the deny question. Keyed on the entity
 * type ALONE — see the module docblock: the signature is the enforcement of
 * "no purpose lifts it". Production wires the registry-backed resolver
 * (PR-5); tests + PR-2's interim seeding use {@link StaticStatutoryEgressDenyResolver}.
 */
export interface StatutoryEgressDenyResolver {
  resolveDeniedFields(entityType: string): StatutoryEgressDecision;
}

const isNonEmptyOwnString = (row: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(row, key) &&
  typeof (row as Record<string, unknown>)[key] === 'string' &&
  ((row as Record<string, unknown>)[key] as string).length > 0;

/**
 * Pure, in-memory {@link StatutoryEgressDenyResolver}. Deterministic and
 * DB-free — the same entity type always yields the same decision (idempotent,
 * no retry surface).
 *
 * **Defaults:** an entity with no rules yields an EMPTY decision. That is the
 * correct semantic for an additive deny-list (nothing is denied where no
 * statute speaks) — the fail-closed duty for a PHI deck whose resolver is
 * MISSING entirely belongs to the PR-2 wiring, not to this pure class.
 *
 * **Construction fails loud:** every rule row must carry own-property,
 * non-empty string `statuteId`/`entityType`/`field`/`jurisdiction`. A
 * malformed row throws — a statutory rule silently dropped (or read off a
 * polluted prototype) is a silent breach, so the registry is validated before
 * any decision is ever served. Duplicate (entityType, field) rows are
 * allowed across statutes; the FIRST statute registered for a field wins the
 * audit attribution (the denial itself is identical either way).
 */
export class StaticStatutoryEgressDenyResolver implements StatutoryEgressDenyResolver {
  /** entityType → (field → statuteId). Map-keyed: no prototype chain to pollute. */
  private readonly byEntity = new Map<string, Map<string, StatuteId>>();

  constructor(rules: readonly StatutoryDenyRule[]) {
    rules.forEach((rule, index) => {
      for (const key of ['statuteId', 'entityType', 'field', 'jurisdiction'] as const) {
        if (!isNonEmptyOwnString(rule, key)) {
          throw new Error(
            `[statutory-egress] registry rule ${index} has a missing/invalid '${key}' — a malformed statutory rule is refused at construction, never silently dropped`
          );
        }
      }
      let fields = this.byEntity.get(rule.entityType);
      if (!fields) {
        fields = new Map<string, StatuteId>();
        this.byEntity.set(rule.entityType, fields);
      }
      if (!fields.has(rule.field)) fields.set(rule.field, rule.statuteId);
    });
  }

  resolveDeniedFields(entityType: string): StatutoryEgressDecision {
    const fields = this.byEntity.get(entityType);
    // FRESH collections every call — no shared mutable sentinel to poison.
    if (!fields) return { deniedFields: new Set<string>(), statuteByField: new Map<string, StatuteId>() };
    return { deniedFields: new Set(fields.keys()), statuteByField: new Map(fields) };
  }
}

/** One present-and-stripped field, with its statute — the audit payload unit. */
export interface StatutorySuppression {
  field: string;
  statuteId: StatuteId;
}

export interface RedactionResult<T> {
  rows: Array<Partial<T>>;
  /**
   * Every field that was PRESENT on at least one row and stripped, deduped,
   * with its statute attribution. Empty ⇒ nothing was suppressed (either no
   * rule for this entity, or no row carried a denied field) — the PR-3 audit
   * emits only when this is non-empty ("present-and-stripped", never "rule
   * existed").
   */
  suppressions: StatutorySuppression[];
  /** How many rows had at least one field stripped. */
  affectedRowCount: number;
}

/**
 * THE egress guard — every sink (readWith post-projection, storage-write,
 * AI-context, offline-sync, export) routes entity rows through this before
 * they leave. Pure: never mutates an input row; an affected row is replaced
 * by a shallow copy with the denied fields OMITTED (absent, not nulled — an
 * absent key is unambiguous; a `null` would leak that the field exists and
 * was set). Unaffected rows pass through by reference, and an entity with no
 * denials returns the input array itself (zero-copy fast path — the
 * overwhelmingly common non-clinical case costs one set-size check).
 */
export function redactStatutoryFields<T extends Record<string, unknown>>(
  rows: readonly T[],
  entityType: string,
  resolver: StatutoryEgressDenyResolver
): RedactionResult<T> {
  const decision = resolver.resolveDeniedFields(entityType);
  if (decision.deniedFields.size === 0) {
    return { rows: rows as unknown as Array<Partial<T>>, suppressions: [], affectedRowCount: 0 };
  }

  const suppressedFields = new Set<string>();
  let affectedRowCount = 0;
  const redacted = rows.map((row) => {
    let hit = false;
    for (const field of decision.deniedFields) {
      if (Object.prototype.hasOwnProperty.call(row, field)) {
        hit = true;
        suppressedFields.add(field);
      }
    }
    if (!hit) return row as Partial<T>;
    affectedRowCount += 1;
    const out: Partial<T> = {};
    for (const key of Object.keys(row)) {
      if (!decision.deniedFields.has(key)) out[key as keyof T] = row[key as keyof T];
    }
    return out;
  });

  const suppressions: StatutorySuppression[] = [...suppressedFields].map((field) => ({
    field,
    // The resolver put every denied field into statuteByField; the fallback
    // can only fire on a hand-rolled resolver that broke that contract, and
    // then the honest attribution is "unknown", never a guessed statute.
    statuteId: decision.statuteByField.get(field) ?? 'unknown-statute'
  }));

  return { rows: redacted, suppressions, affectedRowCount };
}
