/**
 * Record-reference resolution — the batching contract and, more importantly, how
 * it DEGRADES.
 *
 * Two failure modes matter more than the happy path:
 *   1. A record the reader may not see must render as a dash — not as its name
 *      (a leak), and not as the raw uuid (the thing this exists to remove).
 *   2. A deck that cannot be reached must still render something readable, not
 *      an error or an empty cell.
 */

import {
  prefetchRecordLabels,
  peekRecordLabel,
  recordHref,
  resetRecordLabelCache,
  shortRecordId
} from './record-labels';

const OUTLET_A = '11111111-2222-3333-4444-55555555aaaa';
const OUTLET_B = '11111111-2222-3333-4444-55555555bbbb';

type FetchCall = { url: string; body?: Record<string, unknown> };

function mockDeck(options: {
  entities?: Array<{ name: string; qualifiedName: string; displayField?: string }>;
  rows?: Array<Record<string, unknown>>;
  failActions?: boolean;
  failEntities?: boolean;
}): FetchCall[] {
  const calls: FetchCall[] = [];
  (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string, init?: { body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url, body });
    if (url.includes('/entities')) {
      if (options.failEntities) throw new Error('offline');
      return { ok: true, json: async () => ({ entities: options.entities ?? [] }) };
    }
    if (options.failActions) throw new Error('offline');
    return { ok: true, json: async () => ({ ok: true, data: options.rows ?? [] }) };
  }) as unknown as typeof fetch;
  return calls;
}

const OUTLET_META = [{ name: 'Outlet', qualifiedName: 'restroin/Outlet', displayField: 'name' }];

beforeEach(() => {
  resetRecordLabelCache();
  jest.restoreAllMocks();
});

describe('shortRecordId', () => {
  it('keeps the tail — short, stable, and enough to tell two records apart', () => {
    expect(shortRecordId(OUTLET_A)).toBe('#55aaaa');
  });

  it('never returns a bare uuid, which is the whole point', () => {
    expect(shortRecordId(OUTLET_A)).not.toContain(OUTLET_A);
  });

  it('survives an empty id rather than throwing in a render path', () => {
    expect(shortRecordId('')).toBe('');
  });
});

describe('recordHref', () => {
  it('points at the entity detail route the deck already resolves', () => {
    expect(recordHref('Outlet', OUTLET_A)).toBe(`/Outlet/${OUTLET_A}`);
  });

  it('encodes the id — an id is data, not a path fragment to be trusted', () => {
    expect(recordHref('Outlet', 'a/b?c')).toBe('/Outlet/a%2Fb%3Fc');
  });
});

describe('prefetchRecordLabels', () => {
  it('resolves a batch of ids in ONE read, not one per id', async () => {
    const calls = mockDeck({
      entities: OUTLET_META,
      rows: [
        { id: OUTLET_A, name: 'Koramangala' },
        { id: OUTLET_B, name: 'Indiranagar' }
      ]
    });

    await prefetchRecordLabels('restroin/Outlet', [OUTLET_A, OUTLET_B, OUTLET_A]);

    // 1500 references on a report must not become 1500 requests.
    const actionCalls = calls.filter((c) => c.url.includes('/actions'));
    expect(actionCalls).toHaveLength(1);
    expect(peekRecordLabel('restroin/Outlet', OUTLET_A)).toBe('Koramangala');
    expect(peekRecordLabel('restroin/Outlet', OUTLET_B)).toBe('Indiranagar');
  });

  it('reads through the ordinary scoped dispatcher — it invents no privileged path', async () => {
    const calls = mockDeck({ entities: OUTLET_META, rows: [] });
    await prefetchRecordLabels('restroin/Outlet', [OUTLET_A]);

    const action = calls.find((c) => c.url.includes('/actions'));
    // The same tenant-scoped, RBAC-gated, record-scoped read as any other query.
    expect(action?.body?.action).toBe('entity:restroin/Outlet.query');
    expect(action?.body?.args).toMatchObject({ filter: { id: { in: [OUTLET_A] } } });
  });

  it('CRITICAL: an id the read did not return resolves to UNAVAILABLE, never to the uuid', async () => {
    // The reader can see outlet A but not outlet B — so the read comes back with
    // A only. B must not fall back to showing its id or its name.
    mockDeck({ entities: OUTLET_META, rows: [{ id: OUTLET_A, name: 'Koramangala' }] });

    await prefetchRecordLabels('restroin/Outlet', [OUTLET_A, OUTLET_B]);

    expect(peekRecordLabel('restroin/Outlet', OUTLET_A)).toBe('Koramangala');
    expect(peekRecordLabel('restroin/Outlet', OUTLET_B)).toBeNull();
  });

  it('CRITICAL: an unavailable id is not retried forever — it is resolved, not pending', async () => {
    const calls = mockDeck({ entities: OUTLET_META, rows: [] });

    await prefetchRecordLabels('restroin/Outlet', [OUTLET_B]);
    await prefetchRecordLabels('restroin/Outlet', [OUTLET_B]);

    // Left "pending", a record the reader cannot see would re-request on every
    // render — a hot loop against the deck for a row that will never come back.
    expect(calls.filter((c) => c.url.includes('/actions'))).toHaveLength(1);
  });

  it('does not re-read ids it already holds', async () => {
    const calls = mockDeck({ entities: OUTLET_META, rows: [{ id: OUTLET_A, name: 'Koramangala' }] });

    await prefetchRecordLabels('restroin/Outlet', [OUTLET_A]);
    await prefetchRecordLabels('restroin/Outlet', [OUTLET_A]);

    expect(calls.filter((c) => c.url.includes('/actions'))).toHaveLength(1);
  });

  it('fetches the entity metadata ONCE across many batches', async () => {
    const calls = mockDeck({ entities: OUTLET_META, rows: [] });

    await prefetchRecordLabels('restroin/Outlet', [OUTLET_A]);
    await prefetchRecordLabels('restroin/Outlet', [OUTLET_B]);

    expect(calls.filter((c) => c.url.includes('/entities'))).toHaveLength(1);
  });

  it('an unreachable deck degrades to unavailable rather than throwing into a render', async () => {
    mockDeck({ entities: OUTLET_META, failActions: true });

    await expect(prefetchRecordLabels('restroin/Outlet', [OUTLET_A])).resolves.toBeUndefined();
    expect(peekRecordLabel('restroin/Outlet', OUTLET_A)).toBeNull();
  });

  it('an entity with no known label column resolves to unavailable, not to a stringified row', async () => {
    // No displayField declared and none inferable — the consumer's fallback is a
    // short id, which is the UI's job, not a random column's value.
    mockDeck({
      entities: [{ name: 'AuditRow', qualifiedName: 'restroin/AuditRow' }],
      rows: [{ id: OUTLET_A, payload: { secret: 'do not render me' } }]
    });

    await prefetchRecordLabels('restroin/AuditRow', [OUTLET_A]);

    expect(peekRecordLabel('restroin/AuditRow', OUTLET_A)).toBeNull();
  });

  it('a null label column value resolves to unavailable rather than the string "null"', async () => {
    mockDeck({ entities: OUTLET_META, rows: [{ id: OUTLET_A, name: null }] });
    await prefetchRecordLabels('restroin/Outlet', [OUTLET_A]);
    expect(peekRecordLabel('restroin/Outlet', OUTLET_A)).toBeNull();
  });

  it('resetRecordLabelCache drops resolved names — a label must not outlive its session', async () => {
    mockDeck({ entities: OUTLET_META, rows: [{ id: OUTLET_A, name: 'Koramangala' }] });
    await prefetchRecordLabels('restroin/Outlet', [OUTLET_A]);
    expect(peekRecordLabel('restroin/Outlet', OUTLET_A)).toBe('Koramangala');

    resetRecordLabelCache();

    // On a shared machine, a name read in one account's session must not still be
    // sitting in memory for the next.
    expect(peekRecordLabel('restroin/Outlet', OUTLET_A)).toBeUndefined();
  });
});
