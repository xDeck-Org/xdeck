/**
 * §9.91.3 PR-1 — Clinical-retention / suppression-decision primitive. The pure,
 * sandbox-agnostic, DB-agnostic core that answers ONE question at erasure time:
 * for THIS entity (and the facts known about this record), is a hard delete
 * permitted, or does a retention obligation force audited SUPPRESSION
 * (inactivation) instead?
 *
 * **The hard rule: erasure of a retained clinical record is INACTIVATION, never
 * destruction.** EHR Standards for India 2016 — medical records are preserved for
 * the patient's lifetime; DPDP s.12 erasure is overridden where a retention law
 * applies. §9.73's `TelemetryUserErasureService` hard-DELETEs — correct for
 * 30–395d telemetry, fatal for patient-lifetime records. This primitive is the
 * gate a generalised erasure path consults so the retained entities suppress and
 * the rest erase.
 *
 * **Fail-closed = PRESERVE (the inverse of §9.91.2).** Where field-ABAC fails
 * closed by HIDING data, retention fails closed by KEEPING it: a *classified*
 * entity whose disposition cannot be confidently resolved → `suppress` (never a
 * silent destroy). An *unclassified* entity (no rule) → `erase` — the
 * migration-safe opt-in default matching §9.91.1/§9.91.2, so an EMPTY-seeded
 * resolver leaves telemetry (and every current caller) hard-deleting exactly as
 * today: ZERO behaviour change until a vertical classifies an entity.
 *
 * **Not actor-scoped.** Unlike {@link ReadAccessContext} (field/row ABAC, which
 * turn on who-is-reading + why), a retention obligation is a statutory fact about
 * the RECORD, not the actor — so {@link RetentionQuery} carries the entity + the
 * record facts, NOT role/purpose. Erasure is a subject-rights operation; the same
 * record suppresses no matter who processes the request.
 *
 * **PR-1 ships the primitive + the audit vocabulary** (`SUPPRESSION_DECISION` /
 * `RETENTION_EXEMPTION_APPLIED`). The idempotent suppress-EXECUTION service + the
 * generalised §9.24 `onUserErasure` dispatch is `TODO(§9.91.3 PR-2)`; the
 * data-backed resolver doing per-system-of-medicine statutory-PERIOD math
 * (Schedule-H1 / Telemedicine 2020 / Clinical Establishments Act windows) over a
 * persistent relation is `TODO(§9.91.x)` — the interim static resolver models the
 * unconditional-retention + active-treatment-override cases, which need no clock.
 */

/** The disposition of an erasure request for one entity's record(s). */
export type ErasureDisposition = 'erase' | 'suppress';

/**
 * A retention decision.
 *  - `'erase'`    → no retention obligation; the caller may hard-delete (telemetry).
 *  - `'suppress'` → a statutory / active-treatment obligation applies; the caller
 *    must INACTIVATE the record, never destroy it. `exemptionReason` names the
 *    legal/clinical basis and is what the `RETENTION_EXEMPTION_APPLIED` audit row
 *    records. It is `null` only for `'erase'`.
 */
export interface ErasureDecision {
  disposition: ErasureDisposition;
  exemptionReason: string | null;
}

/** The context a retention decision is made against — the entity + record facts. */
export interface RetentionQuery {
  entityType: string;
  /**
   * Caller-supplied facts about THIS record the resolver may consult (read
   * own-property-guarded; the resolver reads only the keys its rule references).
   * The canonical fact is `hasActiveTreatment` (the patient is mid-care → always
   * retain, regardless of the statutory window). A data-backed resolver also
   * derives within-statutory-window from `lastEventAt` + the per-system period;
   * the interim static resolver consumes the boolean the caller pre-computes.
   */
  facts?: Readonly<Record<string, unknown>>;
}

/**
 * Port the host implements to answer "may this entity's record be erased, or must
 * it be suppressed?". The IMPLEMENTATION owns the (entityType → retention rule)
 * RELATION + any statutory-period math.
 */
export interface RetentionPolicyResolver {
  resolveErasure(query: RetentionQuery): ErasureDecision;
}

/**
 * A per-entity retention rule for the static resolver:
 *  - `'erase'` → explicitly NO retention obligation (hard-delete permitted).
 *  - `{ suppress: { reason } }` → UNCONDITIONAL retention (e.g. a lifetime EHR
 *    record): always inactivate, never destroy.
 *  - `{ suppressIfFact, reason, whenFalse? }` → retain WHILE the named fact is
 *    truthy (the active-treatment override). When the fact is present + explicitly
 *    FALSY, apply `whenFalse` (default `'suppress'` — fail-closed). When the fact
 *    is ABSENT or null, fail-closed to `'suppress'` (cannot confirm it is safe to
 *    erase).
 */
export type RetentionRule =
  | 'erase'
  | { suppress: { reason: string } }
  | { suppressIfFact: string; reason: string; whenFalse?: ErasureDisposition };

/**
 * Pure, in-memory {@link RetentionPolicyResolver}. Deterministic + clock-free.
 * Keyed per `entityType` (a `Map`, not a `Record` — no prototype-chain exposure
 * on the top-level lookup; the `facts` bag IS a plain object and so is read
 * own-property-guarded, the §9.91.2 PR-1 `wf_2b5f8caa` lesson applied where it
 * actually bites).
 *
 *  - entity NOT in the map → `'erase'` (unscoped; opt-in classification → an empty
 *    seed is zero behaviour change).
 *  - `'erase'` rule → erase.
 *  - `{ suppress }` rule → unconditional suppress.
 *  - `{ suppressIfFact }` rule → suppress while truthy; fail-closed `'suppress'`
 *    when the fact is absent/null; `whenFalse` (default suppress) when explicitly
 *    falsy. A prototype-polluted `facts` key can NEVER trigger the erase branch.
 */
export class StaticRetentionPolicyResolver implements RetentionPolicyResolver {
  // FRESH decisions every call — never a shared sentinel. `ErasureDecision` is a
  // mutable object, so a single shared `{disposition:'erase',…}` handed across the
  // library boundary could be reassigned by a consumer (`decision.disposition =
  // 'erase'`) and poison every future suppress into a fail-OPEN destroy. This is
  // the §9.91.2 PR-1 shared-mutable-sentinel lesson (`wf_2b5f8caa`) applied up
  // front. The cost is one tiny object per resolve — negligible.
  private static erase(): ErasureDecision {
    return { disposition: 'erase', exemptionReason: null };
  }
  private static suppress(reason: string): ErasureDecision {
    return { disposition: 'suppress', exemptionReason: reason };
  }

  constructor(private readonly rules: ReadonlyMap<string, RetentionRule>) {}

  resolveErasure(query: RetentionQuery): ErasureDecision {
    const rule = this.rules.get(query.entityType);
    // Unclassified entity → erase (opt-in classification; empty seed = zero change).
    if (rule === undefined) return StaticRetentionPolicyResolver.erase();
    if (rule === 'erase') return StaticRetentionPolicyResolver.erase();
    // `in` is safe here: `rule` is trusted host config (a known union shape), NOT a
    // Record keyed by attacker-influenced strings — the prototype-pollution lesson
    // is about UNTRUSTED key LOOKUPS, which is the `facts` bag below, not this
    // union discriminant.
    if ('suppressIfFact' in rule) return this.resolveConditional(rule, query);
    return StaticRetentionPolicyResolver.suppress(rule.suppress.reason);
  }

  /** The active-treatment override. Any unknown / absent fact fails CLOSED to suppress. */
  private resolveConditional(
    rule: { suppressIfFact: string; reason: string; whenFalse?: ErasureDisposition },
    query: RetentionQuery
  ): ErasureDecision {
    const facts = query.facts;
    // OWN-property only — a prototype-polluted fact key cannot satisfy (or, with
    // `whenFalse:'erase'`, DESTROY a record by injecting a falsy value). Fact
    // ABSENT ⇒ cannot confirm it is safe to erase ⇒ fail-closed suppress.
    if (!facts || !Object.prototype.hasOwnProperty.call(facts, rule.suppressIfFact)) {
      return StaticRetentionPolicyResolver.suppress(rule.reason);
    }
    const value = facts[rule.suppressIfFact];
    // null/undefined ⇒ unknown ⇒ fail-closed suppress.
    if (value === null || value === undefined) return StaticRetentionPolicyResolver.suppress(rule.reason);
    // Truthy ⇒ the retain signal is active (e.g. active treatment) ⇒ suppress.
    if (value) return StaticRetentionPolicyResolver.suppress(rule.reason);
    // Present + explicitly falsy ⇒ the override does not apply ⇒ whenFalse (default suppress).
    return rule.whenFalse === 'erase'
      ? StaticRetentionPolicyResolver.erase()
      : StaticRetentionPolicyResolver.suppress(rule.reason);
  }
}
