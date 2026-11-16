/**
 * §9.94 B1 (ADR-0019 D5/D6) — Package WRITE-POLICY resolver primitive. The pure,
 * sandbox-agnostic, DB-agnostic core of the "package shapes a write, the kernel
 * enforces it" seam. Companion to {@link field-access} (field masking) and
 * {@link row-scope} (row narrowing): same {@link ReadAccessContext} actor carrier,
 * distinct concern — this one governs MUTATIONS, not reads.
 *
 * **What it is.** A package that owns a vertical entity (an `Appointment`, an
 * `Order`) often needs to constrain HOW that entity is written — "`status` may only
 * move forward", "`amount` must be ≥ 0", "`confirmedAt` is system-set, never
 * client-set". Today that logic would have to live in `(core)` (a bespoke per-entity
 * code change — the exact accretion ADR-0019 D3 forbids). This port lets the package
 * INJECT that policy; the kernel `KernelWriteGateService` CONSULTS it on every write.
 *
 * **The hard rule (D5): a policy can only NARROW, never WIDEN.** The kernel gates —
 * write-mode (`data_access_mode`), entity write-permission (`writableResources`),
 * the bookkeeping/sensitive field floor, read-before-write row-authz, and the atomic
 * audit — run INDEPENDENTLY of this decision and ALWAYS apply. A policy can `deny` a
 * write the kernel would otherwise allow, or `reject` specific fields; it can NEVER
 * permit a write the kernel gates refuse. So a missing/empty/buggy resolver can only
 * ever be MORE permissive than the kernel floor — i.e. it degrades to "kernel gates
 * only", which is exactly today's `recordWrite` behaviour. That asymmetry is why the
 * unclassified-entity default here is `allow` (no-op), the inverse of field-access /
 * row-scope's fail-closed default: those ARE the security boundary; this sits on top
 * of one.
 *
 * **B1 ships the primitive + the wiring (empty static resolver).** The persistent
 * write-policy RELATION a forcing vertical configures is `TODO(§9.94.x)`; the static
 * resolver below is seeded EMPTY in prod (every entity → `allow`), so it is a NO-OP
 * on every live write today.
 */

import type { PurposeOfUseId, ReadAccessContext } from './field-access';

/**
 * The write operation a policy decision is made for. v1 callers (`recordWrite`)
 * only ever pass `'update'`; `'create'` is named so a policy can distinguish the
 * two when the create path lands (`TODO(§9.52 #5b)`), without a later type change.
 */
export type WriteOperation = 'update' | 'create';

/**
 * The context a write-policy decision is made against — the actor carrier (role +
 * purpose + id, shared with the read primitives) plus the entity, the operation,
 * and the PROPOSED structured payload. The policy MAY inspect `fields`' values to
 * validate them (e.g. an out-of-range `amount`); it receives the proposal, never a
 * committed row.
 */
export interface WritePolicyQuery extends ReadAccessContext {
  /** The entity type being written (e.g. `Appointment`, `Order`). */
  entityType: string;
  /** The write kind. v1 is `'update'`; `'create'` is forward-compat. */
  operation: WriteOperation;
  /**
   * The proposed structured write payload (field → value), scalars only. A
   * read-only snapshot — the policy inspects it to decide; it never mutates it
   * (the kernel applies the floor + the decision, not the policy).
   */
  fields: Readonly<Record<string, unknown>>;
}

/**
 * A package write-policy decision. The package can ONLY narrow:
 *  - `effect: 'deny'`  → reject the whole write (`reason` is a caller-safe string).
 *  - `effect: 'allow'` → permit it (the kernel gates still apply independently);
 *    `rejectedFields`, if present, are field names the policy forbids — the kernel
 *    gate refuses the write LOUDLY if the payload sets any of them (never a silent
 *    strip: a forbidden field is an explicit refusal, same posture as the
 *    bookkeeping floor, so the caller is never misled into thinking the field was
 *    written).
 */
export interface WriteDecision {
  effect: 'allow' | 'deny';
  /** Caller-safe explanation; surfaced on a `deny`. Never leak internal detail. */
  reason?: string;
  /** Field names the policy forbids even though it allows the write overall. */
  rejectedFields?: readonly string[];
}

/**
 * Port the host implements to answer "may this actor write these fields of this
 * entity, and how?". The IMPLEMENTATION owns the
 * (entityType × role × purpose) → rule RELATION; the library defines only the
 * question + the answer shape. Production wires a {@link StaticWritePolicyResolver}
 * seeded EMPTY (B1); a vertical replaces it with a data-backed resolver by
 * re-binding the provider token (`WRITE_POLICY_RESOLVER_TOKEN`).
 */
export interface WritePolicyResolver {
  resolveWritePolicy(query: WritePolicyQuery): WriteDecision;
}

/**
 * A per-entity static write rule for the {@link StaticWritePolicyResolver}:
 *  - `'allow'` → permit (no extra field constraint).
 *  - `'deny'`  → reject every write for this (role, purpose).
 *  - `{ allow: true; rejectedFields }` → permit but forbid the named fields.
 */
export type StaticWriteRule = 'allow' | 'deny' | { allow: true; rejectedFields?: readonly string[] };

/**
 * Per-entity static write policy. Rules keyed by the SAME most-specific precedence
 * as field-access / row-scope: `<role>|<purpose>` → `<role>|*` → `*|<purpose>` →
 * `*|*`. An entity ABSENT from the resolver's map is `allow` (unconstrained — the
 * no-op default; the kernel gates alone govern).
 *
 * **`|` is the composite-key delimiter** (local to this in-memory resolver; the
 * persistent relation keys on columns). Lookup is own-property-guarded — a
 * prototype-polluted key cannot satisfy a classified-entity rule (the §9.91.2 PR-1
 * hardening, `wf_2b5f8caa`).
 */
export interface StaticEntityWritePolicy {
  rules: Record<string, StaticWriteRule>;
}

/**
 * Pure, in-memory {@link WritePolicyResolver}. Deterministic + DB-free.
 *
 *  - entity NOT in the map → `allow` (unconstrained; the no-op default — the kernel
 *    gates are the floor, this only ever adds restrictions).
 *  - matched `'allow'` / `'deny'` → returned verbatim.
 *  - matched `{ allow, rejectedFields }` → allow with the forbidden field list.
 *  - entity IS in the map but NO rule matches the (role, purpose) → `deny`
 *    (fail-closed): once a vertical classifies an entity as write-governed, an
 *    unrecognised actor/purpose must be refused, not silently allowed.
 *
 * Two fail-closed hardenings carried forward from §9.91.2 PR-1 (`wf_2b5f8caa`),
 * applied up front (the /xdeck-values "carry confirmed-defect classes forward" rule):
 *  - **Own-property lookups only** — a prototype-polluted rule key cannot satisfy a
 *    classified entity's miss and flip fail-closed into fail-open.
 *  - **Fresh decision objects** — every `allow`/`deny` is a NEW object, never a
 *    shared mutable sentinel a consumer could reassign (`decision.effect = 'allow'`)
 *    and poison every future deny.
 */
export class StaticWritePolicyResolver implements WritePolicyResolver {
  // FRESH decisions every call — `WriteDecision.effect` is a mutable property, so a
  // shared `{effect:'deny'}` handed across the library boundary could be mutated by a
  // consumer and turn every future deny into a fail-OPEN. One tiny object per resolve
  // — negligible cost, the §9.91.2 PR-1 shared-mutable-sentinel lesson applied up front.
  private static allow(): WriteDecision {
    return { effect: 'allow' };
  }
  private static deny(reason: string): WriteDecision {
    return { effect: 'deny', reason };
  }

  constructor(private readonly policies: ReadonlyMap<string, StaticEntityWritePolicy>) {}

  resolveWritePolicy(query: WritePolicyQuery): WriteDecision {
    const policy = this.policies.get(query.entityType);
    // Unclassified entity → unconstrained (no-op; the kernel gates alone govern).
    if (!policy) return StaticWritePolicyResolver.allow();

    const role = query.actorRole ?? '*';
    const purpose = query.purpose ?? '*';
    const keys = [`${role}|${purpose}`, `${role}|*`, `*|${purpose}`, '*|*'];
    for (const key of keys) {
      // OWN-property only — a prototype-polluted key must NOT satisfy a classified
      // lookup (else fail-closed silently becomes fail-open).
      if (!Object.prototype.hasOwnProperty.call(policy.rules, key)) continue;
      const rule = policy.rules[key];
      // An own key explicitly set to undefined is "no rule" — let the less-specific
      // fallback keys still get their turn.
      if (rule === undefined) continue;
      if (rule === 'allow') return StaticWritePolicyResolver.allow();
      if (rule === 'deny') return StaticWritePolicyResolver.deny(`Writes to '${query.entityType}' are not permitted.`);
      // { allow: true, rejectedFields } — allow but forbid the named fields. Defensive
      // copy of the field list so a consumer can't mutate the policy's own array.
      return { effect: 'allow', rejectedFields: rule.rejectedFields ? [...rule.rejectedFields] : undefined };
    }
    // Classified entity, no matching rule → fail CLOSED.
    return StaticWritePolicyResolver.deny(`No write policy permits this write to '${query.entityType}'.`);
  }
}

/**
 * Evaluate a {@link WriteDecision} against a proposed field set — the kernel-side
 * helper that turns a policy decision into a concrete allow / refuse, so the gate
 * (and its tests) share ONE interpretation of `rejectedFields`. Pure.
 *
 *  - `effect: 'deny'`  → `{ allowed: false, reason }`.
 *  - `effect: 'allow'` with `rejectedFields` → if the payload sets ANY forbidden
 *    field, `{ allowed: false, forbiddenFields }` (LOUD refusal, never a strip);
 *    otherwise `{ allowed: true }`.
 *
 * `forbiddenFields` is the INTERSECTION of the policy's `rejectedFields` and the
 * fields actually present in the payload — so the refusal names only what the caller
 * tried to write, not the whole forbidden list.
 */
export function evaluateWriteDecision(
  decision: WriteDecision,
  fields: readonly string[]
): { allowed: true } | { allowed: false; reason?: string; forbiddenFields?: string[] } {
  if (decision.effect === 'deny') return { allowed: false, reason: decision.reason };
  if (decision.rejectedFields && decision.rejectedFields.length) {
    const forbidden = new Set(decision.rejectedFields);
    const hit = fields.filter((f) => forbidden.has(f));
    if (hit.length) return { allowed: false, forbiddenFields: hit };
  }
  return { allowed: true };
}
