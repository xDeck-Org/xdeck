/**
 * §9.50 Slice 1 — XDeckRuntime shape sanity. The runtime guard
 * (Slice 3) supplies an implementation against this interface; package
 * authors compile against it. A missing domain breaks every package.
 *
 * Most type-checking is compile-time (the assignment below would fail
 * tsc if the shape drifted), but the at-runtime walk gives a fast
 * regression signal on which DOMAINS are declared without forcing tsc
 * across the consumer surface.
 */

import { RUNTIME_API_VERSION, type XDeckRuntime } from './runtime';

describe('XDeckRuntime', () => {
  // Compile-time check via type assignment: a minimal stub that mounts
  // every domain proves the union is at least named correctly. The
  // stub is never invoked at runtime.
  const stub = {
    notification: { send: jest.fn(), broadcast: jest.fn() },
    email: { send: jest.fn() },
    sms: { send: jest.fn() },
    whatsapp: { send: jest.fn() },
    push: { send: jest.fn() },
    ai: {
      complete: jest.fn(),
      embed: jest.fn(),
      // §9.158 — AIAPI gained digestBuild when the digest slice shipped. It is REQUIRED on the
      // interface, so omitting it here did not merely weaken the mock: this spec stopped
      // compiling (TS2741) and the workspace verified nothing until it was noticed.
      digestBuild: jest.fn(),
      agentInvoke: jest.fn(),
      knowledgeQuery: jest.fn()
    },
    template: { render: jest.fn() },
    entity: { read: jest.fn(), write: jest.fn(), readAs: jest.fn() },
    class: { invoke: jest.fn() },
    job: { schedule: jest.fn(), enqueue: jest.fn() },
    event: { emit: jest.fn(), listen: jest.fn() },
    http: { fetch: jest.fn() },
    webhook: { send: jest.fn() },
    storage: { read: jest.fn(), write: jest.fn() },
    secret: { read: jest.fn() },
    payment: { initiate: jest.fn(), status: jest.fn(), refund: jest.fn(), gateways: jest.fn() },
    binding: { sign: jest.fn(), verify: jest.fn() },
    telemetry: { track: jest.fn(), identify: jest.fn(), page: jest.fn() },
    // §9.146 — vertical-neutral §9.61 consumer-link primitive.
    consumer: { ensureLink: jest.fn(), assertDependant: jest.fn(), updateOwnProfile: jest.fn() },
    config: { get: jest.fn() },
    // §9.169 PR-10 — an integration handler's door (identity-scoped: the parent-set run).
    integrator: { callout: jest.fn(), settings: jest.fn() },
    // §9.166 Step 6 — the deck↔consumer invoice ledger.
    invoice: {
      quote: jest.fn(),
      issue: jest.fn(),
      get: jest.fn(),
      list: jest.fn(),
      changes: jest.fn(),
      summary: jest.fn(),
      payments: jest.fn(),
      recordTender: jest.fn(),
      reconcileTender: jest.fn(),
      void: jest.fn(),
      credit: jest.fn(),
      recordOfflineRefund: jest.fn(),
      collectOnline: jest.fn(),
      confirmPayment: jest.fn(),
      refund: jest.fn()
    },
    context: {
      deckId: 'tfg',
      tenantSlug: 'tfg',
      env: 'dev' as const,
      package: { namespace: 'standard', name: 'notify', version: '1.0.0' },
      traceId: 't-1',
      spanId: 's-1'
    }
  } satisfies XDeckRuntime;

  it('declares all 23 expected top-level domains + context', () => {
    const keys = Object.keys(stub).sort();
    expect(keys).toEqual(
      [
        'ai',
        'binding',
        'class',
        // §9.52 — own-install settings reader (identity-scoped, no capability)
        'config',
        // §9.146 — vertical-neutral §9.61 consumer-link primitive
        'consumer',
        'context',
        'email',
        'entity',
        'event',
        'http',
        // §9.169 PR-10 — the integrator door (identity-scoped, no capability)
        'integrator',
        // §9.166 Step 6 — the deck invoice ledger
        'invoice',
        'job',
        'notification',
        'payment',
        'push',
        'secret',
        'sms',
        'storage',
        'telemetry',
        'template',
        'webhook',
        'whatsapp'
      ].sort()
    );
  });

  it('context carries tenant + env + package + trace fields', () => {
    expect(stub.context.deckId).toBe('tfg');
    expect(stub.context.env).toMatch(/dev|uat|prod/);
    expect(stub.context.package.namespace).toBe('standard');
    expect(stub.context.traceId).toBe('t-1');
  });
});

describe('RUNTIME_API_VERSION', () => {
  it('is a stable semver string locked at 0.1.0 for the contract-stub release', () => {
    expect(RUNTIME_API_VERSION).toBe('0.1.0');
  });
});
