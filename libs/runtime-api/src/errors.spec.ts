/**
 * §9.50 Slice 1 — error shape tests. The runtime guard (Slice 3) and
 * test harness (Slice 12) both throw + assert on these via instanceof,
 * so the inheritance chain + code fields must stay stable.
 */

import {
  BudgetExceededError,
  CapabilityNotGrantedError,
  PlanCapabilityMismatchError,
  ReservedCapabilityError,
  RuntimeApiError,
  UnknownCapabilityError
} from './errors';

describe('CapabilityNotGrantedError', () => {
  it('carries capability + packageName + tenantId in the message + as fields', () => {
    const err = new CapabilityNotGrantedError('email:send', 'standard/notify', 'tfg');
    expect(err).toBeInstanceOf(RuntimeApiError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('CAPABILITY_NOT_GRANTED');
    expect(err.capability).toBe('email:send');
    expect(err.packageName).toBe('standard/notify');
    expect(err.tenantId).toBe('tfg');
    expect(err.message).toMatch(/email:send/);
    expect(err.message).toMatch(/standard\/notify/);
    expect(err.message).toMatch(/tfg/);
    expect(err.name).toBe('CapabilityNotGrantedError');
  });
});

describe('ReservedCapabilityError', () => {
  it('carries capability + reason', () => {
    const err = new ReservedCapabilityError('class:invoke:Foo', 'reserved per §9.50.9.1');
    expect(err).toBeInstanceOf(RuntimeApiError);
    expect(err.code).toBe('RESERVED_CAPABILITY');
    expect(err.capability).toBe('class:invoke:Foo');
    expect(err.reason).toBe('reserved per §9.50.9.1');
  });
});

describe('UnknownCapabilityError', () => {
  it('carries the offending string', () => {
    const err = new UnknownCapabilityError('telemetry:send');
    expect(err).toBeInstanceOf(RuntimeApiError);
    expect(err.code).toBe('UNKNOWN_CAPABILITY');
    expect(err.capability).toBe('telemetry:send');
  });
});

describe('PlanCapabilityMismatchError', () => {
  it('carries capability + tenantPlan + requiredPlan', () => {
    const err = new PlanCapabilityMismatchError('ai:complete', 'starter', 'professional');
    expect(err).toBeInstanceOf(RuntimeApiError);
    expect(err.code).toBe('PLAN_CAPABILITY_MISMATCH');
    expect(err.capability).toBe('ai:complete');
    expect(err.tenantPlan).toBe('starter');
    expect(err.requiredPlan).toBe('professional');
  });
});

describe('BudgetExceededError', () => {
  it('carries packageName + tenantId + capInr + currentInr + renders the message', () => {
    const err = new BudgetExceededError('standard/ai-assistant', 'tfg', 5000, 5234.56);
    expect(err).toBeInstanceOf(RuntimeApiError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('BUDGET_EXCEEDED');
    expect(err.packageName).toBe('standard/ai-assistant');
    expect(err.tenantId).toBe('tfg');
    expect(err.capInr).toBe(5000);
    expect(err.currentInr).toBe(5234.56);
    /* The message includes both the numerator + denominator so an
       operator scanning logs without parsing fields sees the cap
       breach immediately. Pinned because the sandbox host's
       package-side UI may render fields directly OR the message —
       both paths need to stay in sync. */
    expect(err.message).toContain('standard/ai-assistant');
    expect(err.message).toContain('tfg');
    expect(err.message).toContain('5234.56');
    expect(err.message).toContain('5000.00');
    expect(err.name).toBe('BudgetExceededError');
  });
});

describe('error code stability — locked for cross-package instanceof', () => {
  // Slice 3 (runtime guard) and Slice 12 (test harness) rely on these
  // codes for HTTP mapping + assertion APIs. Renaming a code is a
  // breaking change for installed packages.
  it('keeps the code values stable', () => {
    expect(new CapabilityNotGrantedError('email:send', 'p', 't').code).toBe('CAPABILITY_NOT_GRANTED');
    expect(new ReservedCapabilityError('class:invoke:x', 'r').code).toBe('RESERVED_CAPABILITY');
    expect(new UnknownCapabilityError('x:y').code).toBe('UNKNOWN_CAPABILITY');
    expect(new PlanCapabilityMismatchError('ai:complete', 'a', 'b').code).toBe('PLAN_CAPABILITY_MISMATCH');
    expect(new BudgetExceededError('p', 't', 100, 200).code).toBe('BUDGET_EXCEEDED');
  });
});
