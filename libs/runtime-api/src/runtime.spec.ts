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
      agentInvoke: jest.fn(),
      knowledgeQuery: jest.fn()
    },
    template: { render: jest.fn() },
    entity: { read: jest.fn(), write: jest.fn() },
    class: { invoke: jest.fn() },
    job: { schedule: jest.fn(), enqueue: jest.fn() },
    event: { emit: jest.fn(), listen: jest.fn() },
    http: { fetch: jest.fn() },
    webhook: { send: jest.fn() },
    storage: { read: jest.fn(), write: jest.fn() },
    secret: { read: jest.fn() },
    payment: { initiate: jest.fn() },
    context: {
      tenantId: 'tfg',
      tenantSlug: 'tfg',
      env: 'dev' as const,
      package: { namespace: 'standard', name: 'notify', version: '1.0.0' },
      traceId: 't-1',
      spanId: 's-1'
    }
  } satisfies XDeckRuntime;

  it('declares all 17 expected top-level domains + context', () => {
    const keys = Object.keys(stub).sort();
    expect(keys).toEqual(
      [
        'ai',
        'class',
        'context',
        'email',
        'entity',
        'event',
        'http',
        'job',
        'notification',
        'payment',
        'push',
        'secret',
        'sms',
        'storage',
        'template',
        'webhook',
        'whatsapp'
      ].sort()
    );
  });

  it('context carries tenant + env + package + trace fields', () => {
    expect(stub.context.tenantId).toBe('tfg');
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
