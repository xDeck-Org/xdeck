/**
 * §9.50 Phase A Slice 12 — author test harness. Published as the
 * `@xdeck/runtime-api/testing` subpath so package authors write
 * jest tests against the same `xdeck` global the real runtime guard
 * (Slice 3) injects.
 *
 * Contract:
 *  - Every method on the returned `xdeck` is a `jest.fn()` — consumers
 *    assert via standard jest matchers (`toHaveBeenCalledWith`, etc.).
 *  - Calls to granted capabilities pass through and resolve `undefined`
 *    by default; consumers override per-test via the standard
 *    `xd.email.send.mockResolvedValue(...)` jest API.
 *  - Calls to NON-granted capabilities throw {@link CapabilityNotGrantedError}
 *    — same error type the real guard (Slice 3) throws, so `instanceof`
 *    checks in package code work identically against the mock and the
 *    real runtime.
 *  - Reserved capabilities (`class:invoke:*`, `event:emit`, `event:listen`)
 *    throw {@link ReservedCapabilityError} regardless of `granted` —
 *    matches §9.50.9.1 + the manifest validator.
 *  - `quotas` records configured budgets onto the peek state for
 *    assertions; enforcement (throwing on exceeded) lives in the real
 *    guard (Slice 3) + the per-package sub-quota work (Phase C Slice 14).
 *
 * The harness depends on `jest.fn()` being available — i.e. it must be
 * imported INSIDE a jest test context. That's the contract for any
 * jest-compatible mock library.
 */

import { CapabilityNotGrantedError } from './errors';
import { ensureNotReserved, type Capability } from './capability';
import type { XDeckContext, XDeckRuntime } from './runtime';

export interface MockTenantRuntimeOptions {
  /**
   * The capabilities the tenant has granted to this package. Calls to
   * any other capability throw {@link CapabilityNotGrantedError}. Empty
   * array models "no capabilities granted" — every call throws.
   */
  granted: Capability[];
  /**
   * Optional quota budgets keyed by free-form string (e.g.
   * `'ai:tokens': 10000`). Recorded onto peek state for assertion
   * convenience; the mock does NOT enforce limits (that's the real
   * guard's job per §9.50.4 + Slice 14).
   */
  quotas?: Record<string, number>;
  /**
   * Overrides for `xdeck.context` — useful when a class under test
   * branches on `context.env` or `context.package.version`. Defaults
   * fill anything not overridden.
   */
  context?: Partial<XDeckContext>;
  /**
   * Package name to report in {@link CapabilityNotGrantedError} when
   * the guard throws. Defaults to `'test/mock-package'`.
   */
  packageName?: string;
}

/**
 * Peek into the mock's internal state — useful for assertions that
 * the standard jest matchers don't cover (which capabilities the test
 * configured, the resolved quotas, etc.).
 */
export interface MockTenantRuntimePeek {
  granted: ReadonlySet<Capability>;
  quotas: Readonly<Record<string, number>>;
  packageName: string;
}

/**
 * Returns a fully-typed {@link XDeckRuntime} where every method is a
 * jest mock wrapped in a capability check.
 *
 * `__peek()` (test-only) exposes the configuration so assertions can
 * verify the right capabilities were configured without re-implementing
 * the granted list.
 */
export function mockTenantRuntime(
  options: MockTenantRuntimeOptions
): jest.MockedObjectDeep<XDeckRuntime> & { __peek(): MockTenantRuntimePeek } {
  const granted = new Set<Capability>(options.granted);
  const quotas = { ...(options.quotas ?? {}) };
  const packageName = options.packageName ?? 'test/mock-package';
  const tenantId = options.context?.tenantId ?? 'tfg';

  // Guard: every method routes through this before invoking its jest.fn.
  // Reservation check fires FIRST so the test sees the reservation error
  // rather than a "not granted" miss for the same string — mirrors the
  // precedence the real guard (Slice 3) uses via the same helper.
  const ensureGranted = (capability: Capability): void => {
    ensureNotReserved(capability);
    if (!granted.has(capability)) {
      throw new CapabilityNotGrantedError(capability, packageName, tenantId);
    }
  };

  // Wrap a jest.fn so callers see a standard mock but every invocation
  // routes through ensureGranted first. Two helpers — static (capability
  // is fixed at construction) vs dynamic (capability derived per-call
  // from the payload, used for entity / class:invoke / secret:read).
  const mockStatic = (capability: Capability): jest.Mock => {
    return jest.fn(() => {
      ensureGranted(capability);
      return undefined;
    });
  };
  const mockDynamic = <P>(capabilityOf: (payload: P) => Capability): jest.Mock => {
    return jest.fn((payload: P) => {
      ensureGranted(capabilityOf(payload));
      return undefined;
    });
  };

  const context: XDeckContext = {
    tenantId,
    tenantSlug: options.context?.tenantSlug ?? tenantId,
    env: options.context?.env ?? 'dev',
    package: options.context?.package ?? { namespace: 'test', name: 'mock-package', version: '0.0.0' },
    traceId: options.context?.traceId ?? 't-mock',
    spanId: options.context?.spanId ?? 's-mock'
  };

  const runtime = {
    notification: {
      send: mockStatic('notification:send-in-app'),
      broadcast: mockStatic('notification:broadcast')
    },
    email: { send: mockStatic('email:send') },
    sms: { send: mockStatic('sms:send') },
    whatsapp: { send: mockStatic('whatsapp:send') },
    push: { send: mockStatic('push:send') },
    ai: {
      complete: mockStatic('ai:complete'),
      embed: mockStatic('ai:embed'),
      agentInvoke: mockStatic('ai:agent-invoke'),
      knowledgeQuery: mockStatic('ai:knowledge-query')
    },
    template: { render: mockStatic('template:render') },
    entity: {
      // Parameterized — derive the capability string from payload.entityName.
      read: mockDynamic((p: { entityName: string }) => `entity:read:${p.entityName}` as Capability),
      write: mockDynamic((p: { entityName: string }) => `entity:write:${p.entityName}` as Capability)
    },
    class: {
      // Reserved per §9.50.9.1 — always throws ReservedCapabilityError
      // regardless of grants. capabilityOf still resolves the parameterized
      // string so the error message names the requested class id.
      invoke: mockDynamic((p: { classId: string }) => `class:invoke:${p.classId}` as Capability)
    },
    job: {
      schedule: mockStatic('job:schedule'),
      enqueue: mockStatic('job:enqueue')
    },
    event: {
      // Reserved per §9.50.9.1.
      emit: mockStatic('event:emit' as Capability),
      listen: mockStatic('event:listen' as Capability)
    },
    http: { fetch: mockStatic('http:fetch-allowlisted') },
    webhook: { send: mockStatic('webhook:send') },
    storage: {
      read: mockStatic('storage:read'),
      write: mockStatic('storage:write')
    },
    secret: {
      read: mockDynamic((p: { key: string }) => `secret:read:${p.key}` as Capability)
    },
    payment: { initiate: mockStatic('payment:initiate') },
    context,
    __peek(): MockTenantRuntimePeek {
      return { granted: new Set(granted), quotas: { ...quotas }, packageName };
    }
  } as unknown as jest.MockedObjectDeep<XDeckRuntime> & { __peek(): MockTenantRuntimePeek };

  return runtime;
}
