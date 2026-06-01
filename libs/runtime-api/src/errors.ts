/**
 * §9.50 — runtime errors thrown by the guard layer (Slice 3) and the
 * test harness (Slice 12). Lives in this package so both consumers + the
 * server-side runtime + the published test harness all share the same
 * error class names (instanceof checks survive across package boundaries
 * because every consumer imports from `@xdeck/runtime-api`).
 */

import type { Capability } from './capability';

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
    public readonly tenantId: string
  ) {
    super(
      `[runtime-api] capability '${capability}' is not granted to package '${packageName}' for tenant '${tenantId}'`
    );
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
    super(`[runtime-api] capability '${capability}' is not part of the §9.50 catalogue`);
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
 */
export class BudgetExceededError extends RuntimeApiError {
  readonly code = 'BUDGET_EXCEEDED';
  constructor(
    public readonly packageName: string,
    public readonly tenantId: string,
    public readonly capInr: number,
    public readonly currentInr: number
  ) {
    super(
      `[runtime-api] monthly AI budget exceeded for package '${packageName}' on tenant '${tenantId}': ₹${currentInr.toFixed(2)} / ₹${capInr.toFixed(2)} cap`
    );
  }
}
