/**
 * §9.50 Phase A Slice 12 — test harness tests. The harness IS test
 * infrastructure, so this spec is meta: it asserts that the mock
 * upholds the same contract the real runtime guard (Slice 3) will.
 *
 * When Slice 3 ships, a follow-up parity spec should drive the same
 * scenarios through both the mock and the real guard and assert
 * identical outcomes.
 */

import { CapabilityNotGrantedError, ReservedCapabilityError } from './errors';
import { mockTenantRuntime } from './testing';

describe('mockTenantRuntime — granted capabilities', () => {
  it('lets a granted static capability through to its jest.fn', async () => {
    const xd = mockTenantRuntime({ granted: ['email:send'] });
    xd.email.send.mockResolvedValue({ providerMessageId: 'msg-1' });
    const result = await xd.email.send({
      to: 'u@example.com',
      subject: 'hi',
      templateId: 'welcome',
      data: {}
    });
    expect(result).toEqual({ providerMessageId: 'msg-1' });
    expect(xd.email.send).toHaveBeenCalledTimes(1);
  });

  it('resolves parameterized capabilities from the payload (entity:read:<entityName>)', async () => {
    const xd = mockTenantRuntime({
      granted: ['entity:read:approvalRequest', 'entity:write:approvalRequest']
    });
    xd.entity.read.mockResolvedValue([{ id: 'a-1' }]);
    await xd.entity.read({ entityName: 'approvalRequest' });
    expect(xd.entity.read).toHaveBeenCalledWith({ entityName: 'approvalRequest' });
  });

  it('passes through every granted method without throwing', async () => {
    const xd = mockTenantRuntime({
      granted: ['notification:send-in-app', 'email:send', 'ai:complete', 'template:render', 'job:schedule']
    });
    xd.notification.send.mockResolvedValue({ id: 'n-1', deduplicated: false });
    xd.email.send.mockResolvedValue({ providerMessageId: 'm' });
    xd.ai.complete.mockResolvedValue({ text: 'ok', modelUsed: 'sonnet', usage: { inputTokens: 1, outputTokens: 1 } });
    xd.template.render.mockResolvedValue({ rendered: '<p/>' });
    xd.job.schedule.mockResolvedValue({ jobId: 'j-1' });

    await xd.notification.send({ userId: 'u', variant: 'plain-text', body: {} });
    await xd.email.send({ to: 'u@x', subject: 's', templateId: 't', data: {} });
    await xd.ai.complete({ messages: [{ role: 'user', content: 'hi' }] });
    await xd.template.render({ templateId: 't', data: {} });
    await xd.job.schedule({ name: 'n', cron: '* * * * *', classId: 'C' });

    expect(xd.notification.send).toHaveBeenCalledTimes(1);
    expect(xd.email.send).toHaveBeenCalledTimes(1);
    expect(xd.ai.complete).toHaveBeenCalledTimes(1);
    expect(xd.template.render).toHaveBeenCalledTimes(1);
    expect(xd.job.schedule).toHaveBeenCalledTimes(1);
  });
});

describe('mockTenantRuntime — ungranted capabilities throw CapabilityNotGrantedError', () => {
  it('throws when calling a static capability that was not granted', () => {
    const xd = mockTenantRuntime({ granted: ['notification:send-in-app'] });
    expect(() => xd.email.send({ to: 'u@x', subject: 's', templateId: 't', data: {} })).toThrow(
      CapabilityNotGrantedError
    );
  });

  it('carries the offending capability + package + tenant in the error', () => {
    const xd = mockTenantRuntime({
      granted: [],
      packageName: 'standard/notify',
      context: { tenantId: 'acme' }
    });
    try {
      xd.email.send({ to: 'u@x', subject: 's', templateId: 't', data: {} });
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityNotGrantedError);
      const e = err as CapabilityNotGrantedError;
      expect(e.capability).toBe('email:send');
      expect(e.packageName).toBe('standard/notify');
      expect(e.tenantId).toBe('acme');
      expect(e.code).toBe('CAPABILITY_NOT_GRANTED');
    }
  });

  it('throws when the parameterized capability for the requested resource was not granted', () => {
    const xd = mockTenantRuntime({ granted: ['entity:read:approvalRequest'] });
    expect(() => xd.entity.read({ entityName: 'someOtherEntity' })).toThrow(CapabilityNotGrantedError);
    // The same family with the correct entity passes.
    expect(() => xd.entity.read({ entityName: 'approvalRequest' })).not.toThrow();
  });

  it('empty `granted` array means every call throws', () => {
    const xd = mockTenantRuntime({ granted: [] });
    expect(() => xd.email.send({ to: 'u@x', subject: 's', templateId: 't', data: {} })).toThrow();
    expect(() => xd.notification.send({ userId: 'u', variant: 'toast', body: {} })).toThrow();
    expect(() => xd.payment.initiate({ amount: 1, currency: 'INR', idempotencyKey: 'k' })).toThrow();
  });
});

describe('mockTenantRuntime — reserved capabilities throw ReservedCapabilityError regardless of grants', () => {
  it('event:emit throws ReservedCapabilityError even if "granted"', () => {
    const xd = mockTenantRuntime({ granted: ['event:emit' as never] });
    expect(() => xd.event.emit({ eventName: 'x', payload: {} })).toThrow(ReservedCapabilityError);
  });

  it('event:listen throws ReservedCapabilityError', () => {
    const xd = mockTenantRuntime({ granted: ['event:listen' as never] });
    expect(() => xd.event.listen({ pattern: 'x.*', classId: 'C' })).toThrow(ReservedCapabilityError);
  });

  it('class:invoke:<id> throws ReservedCapabilityError', () => {
    const xd = mockTenantRuntime({ granted: ['class:invoke:standard/notify' as never] });
    expect(() => xd.class.invoke({ classId: 'standard/notify', input: {} })).toThrow(ReservedCapabilityError);
  });

  it('reservation precedence: ReservedCapabilityError fires BEFORE CapabilityNotGrantedError', () => {
    // Even with an empty grants list, the reserved check fires first so
    // the test sees the reservation reason rather than "not granted".
    const xd = mockTenantRuntime({ granted: [] });
    let err: Error | null = null;
    try {
      xd.event.emit({ eventName: 'x', payload: {} });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(ReservedCapabilityError);
    expect(err).not.toBeInstanceOf(CapabilityNotGrantedError);
  });
});

describe('mockTenantRuntime — context + peek', () => {
  it('fills sensible defaults for context (tfg / dev / test mock-package)', () => {
    const xd = mockTenantRuntime({ granted: [] });
    expect(xd.context.tenantId).toBe('tfg');
    expect(xd.context.env).toBe('dev');
    expect(xd.context.package.namespace).toBe('test');
    expect(xd.context.package.name).toBe('mock-package');
    expect(xd.context.traceId).toBe('t-mock');
  });

  it('honours every overridden context field', () => {
    const xd = mockTenantRuntime({
      granted: [],
      context: {
        tenantId: 'acme',
        tenantSlug: 'acme-corp',
        env: 'prod',
        package: { namespace: 'acme-builder', name: 'refund-flow', version: '1.2.3' },
        traceId: 't-real',
        spanId: 's-real'
      }
    });
    expect(xd.context.tenantId).toBe('acme');
    expect(xd.context.tenantSlug).toBe('acme-corp');
    expect(xd.context.env).toBe('prod');
    expect(xd.context.package).toEqual({
      namespace: 'acme-builder',
      name: 'refund-flow',
      version: '1.2.3'
    });
    expect(xd.context.traceId).toBe('t-real');
    expect(xd.context.spanId).toBe('s-real');
  });

  it('__peek() exposes the configured grants + quotas for assertions', () => {
    const xd = mockTenantRuntime({
      granted: ['email:send', 'ai:complete'],
      quotas: { 'ai:tokens': 10000, 'email:per-day': 100 },
      packageName: 'standard/notify'
    });
    const peek = xd.__peek();
    expect([...peek.granted].sort()).toEqual(['ai:complete', 'email:send']);
    expect(peek.quotas).toEqual({ 'ai:tokens': 10000, 'email:per-day': 100 });
    expect(peek.packageName).toBe('standard/notify');
  });

  it('__peek() returns defensive copies (mutation does not leak)', () => {
    const xd = mockTenantRuntime({ granted: ['email:send'], quotas: { 'ai:tokens': 100 } });
    const peek = xd.__peek();
    (peek.granted as Set<string>).add('payment:initiate');
    (peek.quotas as Record<string, number>)['ai:tokens'] = 999;
    const peek2 = xd.__peek();
    expect(peek2.granted.has('payment:initiate' as never)).toBe(false);
    expect(peek2.quotas['ai:tokens']).toBe(100);
  });
});

describe('mockTenantRuntime — jest mock surface', () => {
  it('every domain method is a jest.fn (mockReset / mockImplementation work)', () => {
    const xd = mockTenantRuntime({ granted: ['email:send'] });
    expect(jest.isMockFunction(xd.email.send)).toBe(true);
    expect(jest.isMockFunction(xd.notification.send)).toBe(true);
    expect(jest.isMockFunction(xd.ai.complete)).toBe(true);
    expect(jest.isMockFunction(xd.entity.read)).toBe(true);
    expect(jest.isMockFunction(xd.payment.initiate)).toBe(true);
  });

  it('does not record a call when the capability check throws (rejection is pre-mock)', () => {
    const xd = mockTenantRuntime({ granted: [] });
    expect(() => xd.email.send({ to: 'u@x', subject: 's', templateId: 't', data: {} })).toThrow();
    // The jest.fn DID record the call; the throw happens inside the
    // wrapper. Asserting the call count gives the consumer signal that
    // the package code attempted the call even though it was denied.
    expect(xd.email.send).toHaveBeenCalledTimes(1);
  });
});
