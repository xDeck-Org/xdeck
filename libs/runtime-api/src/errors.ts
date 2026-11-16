/**
 * §9.50 — runtime errors thrown by the guard layer (Slice 3) and the
 * test harness (Slice 12). Lives in this package so both consumers + the
 * server-side runtime + the published test harness all share the same
 * error class names (instanceof checks survive across package boundaries
 * because every consumer imports from `@xdeck/runtime-api`).
 */

import type { Capability } from './capability';
import type { AiSkillEntryRejection } from './ai-skill';

/** Base class for every runtime-API error. */
export abstract class RuntimeApiError extends Error {
  abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Thrown when a package class invokes an `xdeck.*` method whose
 * capability is NOT in the tenant's grants for this package. The guard
 * (Slice 3) checks before any side effect; the error never leaks
 * partial state.
 */
export class CapabilityNotGrantedError extends RuntimeApiError {
  readonly code = 'CAPABILITY_NOT_GRANTED';
  constructor(
    public readonly capability: Capability,
    public readonly packageName: string,
    public readonly deckId: string
  ) {
    super(`[runtime-api] capability '${capability}' is not granted to package '${packageName}' for tenant '${deckId}'`);
  }
}

/**
 * Thrown when a manifest declares a capability that is reserved
 * (`class:invoke:*`, `event:emit`, `event:listen`) — these strings are
 * recognised but non-grantable per §9.50.9.1. Manifest validation
 * (Slice 2) raises this at publish time; runtime guard (Slice 3) also
 * raises if a manifest somehow slipped past validation.
 */
export class ReservedCapabilityError extends RuntimeApiError {
  readonly code = 'RESERVED_CAPABILITY';
  constructor(
    public readonly capability: string,
    public readonly reason: string
  ) {
    super(`[runtime-api] capability '${capability}' is reserved and cannot be granted today: ${reason}`);
  }
}

/**
 * Thrown when a manifest declares an unknown capability string —
 * something that's not in the closed-set catalogue. Manifest validation
 * raises this at publish time; the runtime never reaches code paths
 * for unknown capabilities.
 */
export class UnknownCapabilityError extends RuntimeApiError {
  readonly code = 'UNKNOWN_CAPABILITY';
  constructor(public readonly capability: string) {
    // The catalogue: §9.50.
    super(`[runtime-api] capability '${capability}' is not part of the capability catalogue`);
  }
}

/**
 * §9.94 B5.a (ADR-0019 D9) — thrown when a manifest's `capabilities.provides` entry is not
 * a valid provided-capability string: either malformed (`<namespace>:<name>@<semver>`) or
 * it shadows a KERNEL namespace (D9.3 "kernel wins" — a package can never provide
 * `email:*`, `class:*`, …). Raised by manifest validation at publish time; the registry
 * (B5.b) re-checks at derive-from-manifest time so a malformed declaration never persists.
 */
export class ProvidedCapabilityError extends RuntimeApiError {
  readonly code = 'INVALID_PROVIDED_CAPABILITY';
  constructor(
    public readonly capability: string,
    public readonly reason:
      'malformed' | 'kernel_namespace' | 'system_only' | 'no_handler' | 'orphan_handler' | 'bad_ai_execution'
  ) {
    super(ProvidedCapabilityError.message(capability, reason));
  }
  private static message(capability: string, reason: ProvidedCapabilityError['reason']): string {
    switch (reason) {
      case 'kernel_namespace':
        return `[runtime-api] provided capability '${capability}' uses a reserved kernel namespace (D9.3: a package cannot shadow a kernel capability)`;
      case 'bad_ai_execution':
        // §9.52.15 A2 — the descriptor's `aiExecution` is not one of 'forbidden' | 'draft' | 'auto'.
        return `[runtime-api] provided capability '${capability}' has an invalid 'aiExecution' (expected 'forbidden' | 'draft' | 'auto')`;
      case 'system_only':
        // The bare (no-@semver) form is a kernel-capability MOUNT — only a `system` package may
        // back a kernel verb. A regular package declaring e.g. 'email:send' is rejected (D9.3).
        return `[runtime-api] provided capability '${capability}' mounts a kernel namespace; only a 'system' package may declare a bare kernel-capability mount`;
      case 'no_handler':
        // §9.94 B5.c — a D9 provided capability with no broker handler is unbrokerable.
        return `[runtime-api] provided capability '${capability}' has no entry in 'capabilities.providesHandlers' (the broker has no class/method to invoke)`;
      case 'orphan_handler':
        // §9.94 B5.c — a handler bound to a capability the package does not provide.
        return `[runtime-api] providesHandlers key '${capability}' does not match any declared 'provides' capability`;
      default:
        return `[runtime-api] provided capability '${capability}' is malformed; expected '<namespace>:<name>@<semver>'`;
    }
  }
}

/**
 * §9.94 B5.b (ADR-0019 D9.2) — thrown when a manifest's `capabilities.consumes` entry is not
 * a valid consumed-capability string: malformed (`<namespace>:<name>@<range>`) or it names a
 * KERNEL namespace (those are consumed via `capabilities.required`/`.optional`, not the
 * package→package graph). Raised by manifest validation at publish time. Distinct from the
 * install-time `CAPABILITY_NOT_PROVIDED` (which fires when the SHAPE is valid but no installed
 * package provides a satisfying version) — this is a malformed DECLARATION, not a missing provider.
 */
export class ConsumedCapabilityError extends RuntimeApiError {
  readonly code = 'INVALID_CONSUMED_CAPABILITY';
  constructor(
    public readonly capability: string,
    public readonly reason: 'malformed' | 'kernel_namespace'
  ) {
    super(
      reason === 'kernel_namespace'
        ? `[runtime-api] consumed capability '${capability}' names a kernel namespace; consume kernel capabilities via 'capabilities.required'/'optional', not the package graph`
        : `[runtime-api] consumed capability '${capability}' is malformed; expected '<namespace>:<name>@<range>'`
    );
  }
}

/**
 * §9.52.18 — thrown when a manifest's `capabilities.skills[]` entry fails the AI-Skill
 * publish gate (`validateAiSkillEntry`): `malformed` (wrong shape), `empty_instructions`,
 * `deck_scope_forbidden_for_package` (a package may not author deck-wide behavioral
 * guidance — that is platform/tenant-authored only), or `capability_not_provided` (the
 * prompt-injection SANDBOX: a package skill must target a capability the package itself
 * provides). Raised by `validateManifestCapabilities` at publish; `resolveAiSkills` also
 * drops violators defensively at read-time (defence in depth). `capability` carries the
 * offending skill's scope so it renders in the same path as the capability errors.
 */
export class AiSkillError extends RuntimeApiError {
  readonly code = 'INVALID_AI_SKILL';
  constructor(
    public readonly capability: string,
    public readonly reason: AiSkillEntryRejection
  ) {
    super(AiSkillError.message(capability, reason));
  }
  private static message(capability: string, reason: AiSkillEntryRejection): string {
    switch (reason) {
      case 'empty_instructions':
        return `[runtime-api] AI Skill '${capability}' has empty instructions`;
      case 'deck_scope_forbidden_for_package':
        return `[runtime-api] AI Skill '${capability}' is deck-scoped; a package may only author a skill for a capability it provides (deck-wide guidance is platform/tenant-authored)`;
      case 'capability_not_provided':
        return `[runtime-api] AI Skill '${capability}' targets a capability this package does not provide (the AI-Skill sandbox)`;
      default:
        return `[runtime-api] AI Skill entry '${capability}' is malformed; expected { scope: '<namespace>:<name>', instructions }`;
    }
  }
}

/**
 * Thrown when a tenant's plan does not support a capability the package
 * declared as required (e.g. an `ai:complete` package on a tenant with
 * the LLM tier disabled). Surfaced at install-time approval (Phase B
 * Slice 6) so the tenant sees why the install is refused.
 */
export class PlanCapabilityMismatchError extends RuntimeApiError {
  readonly code = 'PLAN_CAPABILITY_MISMATCH';
  constructor(
    public readonly capability: Capability,
    public readonly tenantPlan: string,
    public readonly requiredPlan: string
  ) {
    super(`[runtime-api] capability '${capability}' requires plan '${requiredPlan}'; tenant is on '${tenantPlan}'`);
  }
}

/**
 * §9.52 Slice 6 — Thrown when a package's monthly AI spend exceeds its
 * configured cap. The hard-cap layer sits in `AiCapabilityService` BEFORE
 * the proxy resolution, so a capped package never reaches the upstream
 * provider — the next `xdeck.ai.complete()` / `xdeck.ai.embed()` call
 * raises this from inside the sandbox host.
 *
 * **Why per-package + INR (not per-tenant + USD).** The tenant-level cap
 * is enforced upstream by the LiteLLM proxy on the virtual key
 * (`max_budget` in USD). This per-package cap is a SECOND line of defence
 * that prevents one runaway package from eating the whole tenant budget.
 * INR matches the invoice line items the cap protects (which already use
 * `AI_BILLING_INR_PER_1K_TOKENS`).
 *
 * **Fields are stable wire surface.** Sandbox callers can read `capInr`
 * + `currentInr` from the thrown error to render the "monthly cap
 * reached: ₹X / ₹Y" message in the package's own UI without parsing the
 * message string. Localisation lives at the package boundary.
 *
 * That sentence was aspirational until the sandbox error envelope carried
 * structured fields: the parent serialised only `name`/`message`/`code`, so
 * both numbers were dropped at the worker boundary and message-scraping was
 * the only way to get them. `extractErrorDetails` in the pool now forwards
 * own enumerable properties, so the promise above holds — and
 * `sandbox-error-envelope.spec.ts` pins it against regressing back.
 */
export class BudgetExceededError extends RuntimeApiError {
  readonly code = 'BUDGET_EXCEEDED';
  constructor(
    public readonly packageName: string,
    public readonly deckId: string,
    public readonly capInr: number,
    public readonly currentInr: number
  ) {
    super(
      `[runtime-api] monthly AI budget exceeded for package '${packageName}' on tenant '${deckId}': ₹${currentInr.toFixed(2)} / ₹${capInr.toFixed(2)} cap`
    );
  }
}

/**
 * A per-deck PLAN limit was reached — the shared error for every governor-style
 * quota, whatever it meters.
 *
 * **One error type, not one per limit.** Storage, message volume, class count,
 * concurrent executions and scheduled jobs are the same event from a deck's
 * point of view: "this deck has used all of something its plan allows." A
 * caller branches on `limit` to decide what to do, not on a different class per
 * quota — which is what keeps a new limit from needing a new error, a new code,
 * and a new arm in every translator between here and the browser.
 *
 * **The fields are the point.** Before this, a deck hitting the email cap could
 * only substring-match `'PLAN_EMAIL_VOLUME_CAP_EXCEEDED'` out of a message
 * built for humans, and the storage cap arrived as a bare `ForbiddenException`
 * with no numbers at all. A class that wants to queue-and-retry rather than
 * fail needs `retryAfterSeconds`; one that wants to warn an operator needs
 * `used` and `cap`. Those are interface, not prose.
 *
 * **Catchable by design, and audited before it is thrown.** Unlike a wall-clock
 * or heap breach — which terminates the worker outright, because a deck must
 * not be able to keep running past a resource limit that protects everyone
 * else — a plan quota is something a deck can sensibly handle: degrade, defer,
 * or tell its user. So it arrives as an ordinary catchable rejection. The
 * corollary is non-negotiable: whatever enforces the limit MUST record the
 * breach before raising, because a deck that catches and ignores this must not
 * thereby make the violation invisible.
 */
export class LimitExceededError extends RuntimeApiError {
  readonly code = 'LIMIT_EXCEEDED';
  constructor(
    /** Stable identifier for WHICH limit, e.g. `storage.bytes`, `email.daily`. */
    public readonly limit: string,
    public readonly deckId: string,
    /** Consumption at the moment of refusal, in the limit's own unit. */
    public readonly used: number,
    /** The plan-derived ceiling, same unit as `used`. */
    public readonly cap: number,
    /** Plan the cap came from — so a deck can say "upgrade to X" accurately. */
    public readonly plan: string,
    /** Set when the quota refills on a clock (rate/volume windows); omitted for
     *  standing limits like total storage, where waiting changes nothing. */
    public readonly retryAfterSeconds?: number
  ) {
    super(
      `[runtime-api] plan limit '${limit}' reached for deck '${deckId}': ${used} / ${cap} (plan '${plan}')` +
        (retryAfterSeconds !== undefined ? `; retry in ${retryAfterSeconds}s` : '')
    );
  }
}
