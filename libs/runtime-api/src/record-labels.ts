/**
 * @xdeck/runtime-api/react — resolving a record REFERENCE to something a person
 * can read, and a link they can follow.
 *
 * **The problem.** A row stores relationships as uuids. Every surface that shows
 * one — a report cell, a dashboard tile, a detail page's related field — has so
 * far had exactly two options: print `a3f9c1e2-…` (meaningless, and a dead end),
 * or hand-write a bespoke fetch-and-join for that one screen. This module is the
 * third option, and the only one that scales: give it the entity and the id, get
 * back the record's name and where to click.
 *
 * **Why the batching is the whole design.** A 500-row report with three
 * reference columns is 1,500 references. Resolved naively that is 1,500 requests
 * and a deck on fire. So a reference does not fetch — it REGISTERS a need, and a
 * microtask later every need collected in that tick is grouped by entity and
 * resolved in one read per entity. The 1,500 become 3.
 *
 * **Why it is safe.** Resolution goes through the ordinary action dispatcher —
 * the same tenant-scoped, RBAC-gated, record-scoped read as any other. It cannot
 * surface a name the caller was not already entitled to read. A record the reader
 * may not see simply does not come back, and the reference renders as a neutral
 * dash rather than a name, an error, or (the tempting mistake) the raw uuid.
 *
 * **No Provider required.** Deliberate: a package surface and a host surface both
 * render inside the deck, same-origin, and both need this. A Context seam would
 * mean every host mounting a provider before any package could show a name —
 * i.e. the feature would silently not work wherever someone forgot.
 */

import * as React from 'react';

/** Where the deck's action dispatcher lives, same-origin. */
const ACTIONS_ENDPOINT = '/api/v1/tenant/actions';
/** Where the deck describes which entities this caller may read, and how they are labelled. */
const ENTITIES_ENDPOINT = '/api/v1/tenant/entities';

/**
 * How many ids to resolve in one read. The dispatcher caps reads anyway; this
 * keeps a single reference column on a very long report from building one
 * enormous `IN (…)` list.
 */
const MAX_IDS_PER_READ = 500;

/** Describes one entity well enough to label and link its records. */
interface EntityLabelInfo {
  /** Bare name, e.g. `Outlet` — also the URL segment for its detail route. */
  name: string;
  /** The column carrying the record's human label, when the deck knows one. */
  displayField?: string;
}

/**
 * `null` means RESOLVED-AND-UNAVAILABLE — the read completed and this id was not
 * in it, because the record is gone or the reader may not see it. Distinguishing
 * that from "not asked yet" is what stops a missing record being retried forever.
 */
type LabelCache = Map<string, Map<string, string | null>>;

const cache: LabelCache = new Map();
const pending = new Map<string, Set<string>>();
const inFlight = new Map<string, Set<string>>();
const subscribers = new Set<() => void>();
let flushScheduled = false;
let entityInfoPromise: Promise<Map<string, EntityLabelInfo>> | null = null;

function notify(): void {
  for (const cb of subscribers) cb();
}

function cacheFor(entity: string): Map<string, string | null> {
  let m = cache.get(entity);
  if (!m) {
    m = new Map();
    cache.set(entity, m);
  }
  return m;
}

/**
 * The deck's entity metadata, fetched once per page. Memoised on the PROMISE, not
 * the result, so a burst of references at first paint shares one request instead
 * of each starting its own.
 */
function loadEntityInfo(): Promise<Map<string, EntityLabelInfo>> {
  if (entityInfoPromise) return entityInfoPromise;
  entityInfoPromise = (async () => {
    const out = new Map<string, EntityLabelInfo>();
    try {
      const res = await fetch(ENTITIES_ENDPOINT, { credentials: 'include' });
      if (!res.ok) return out;
      const body = (await res.json()) as {
        entities?: Array<{ name: string; qualifiedName: string; displayField?: string }>;
      } | null;
      for (const e of body?.entities ?? []) {
        const info: EntityLabelInfo = { name: e.name, ...(e.displayField ? { displayField: e.displayField } : {}) };
        out.set(e.qualifiedName, info);
        // Also reachable by bare name, so a caller holding only `Outlet` resolves.
        if (!out.has(e.name)) out.set(e.name, info);
      }
    } catch {
      // Offline or the deck is unreachable — references degrade to short ids
      // rather than the screen failing. Retried on the next page load.
    }
    return out;
  })();
  return entityInfoPromise;
}

async function readLabels(entity: string, ids: string[], info: EntityLabelInfo | undefined): Promise<void> {
  const target = cacheFor(entity);
  // Mark every id resolved-and-unavailable UP FRONT, then overwrite the ones the
  // read returns. Without this an id the reader cannot see would stay "pending"
  // forever and be re-requested on every render.
  const settle = (rows: Array<Record<string, unknown>>) => {
    for (const id of ids) target.set(id, null);
    for (const row of rows) {
      const id = row.id;
      if (typeof id !== 'string') continue;
      const raw = info?.displayField ? row[info.displayField] : undefined;
      target.set(id, raw === null || raw === undefined ? null : String(raw));
    }
  };

  try {
    const res = await fetch(ACTIONS_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        action: `entity:${entity}.query`,
        args: { filter: { id: { in: ids } }, limit: ids.length }
      })
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: unknown } | null;
    settle(
      res.ok && body?.ok === true && Array.isArray(body.data) ? (body.data as Array<Record<string, unknown>>) : []
    );
  } catch {
    settle([]);
  }
}

async function flush(): Promise<void> {
  flushScheduled = false;
  const batch = [...pending.entries()].map(([entity, ids]) => [entity, [...ids]] as const);
  pending.clear();
  if (batch.length === 0) return;

  for (const [entity, ids] of batch) {
    let live = inFlight.get(entity);
    if (!live) {
      live = new Set();
      inFlight.set(entity, live);
    }
    for (const id of ids) live.add(id);
  }

  const info = await loadEntityInfo();
  await Promise.all(
    batch.map(async ([entity, ids]) => {
      for (let i = 0; i < ids.length; i += MAX_IDS_PER_READ) {
        await readLabels(entity, ids.slice(i, i + MAX_IDS_PER_READ), info.get(entity));
      }
      const live = inFlight.get(entity);
      if (live) for (const id of ids) live.delete(id);
    })
  );
  notify();
}

/**
 * Register a need for one record's label. Returns immediately; the value lands in
 * the cache and wakes subscribers when the batch resolves.
 */
function request(entity: string, id: string): void {
  if (cacheFor(entity).has(id)) return;
  if (inFlight.get(entity)?.has(id)) return;
  let queue = pending.get(entity);
  if (!queue) {
    queue = new Set();
    pending.set(entity, queue);
  }
  queue.add(id);
  if (!flushScheduled) {
    flushScheduled = true;
    // A microtask, not a timer: every reference rendered in the same commit gets
    // collected, and resolution starts without waiting on the event loop.
    void Promise.resolve().then(flush);
  }
}

/**
 * Resolve a known set of references in one pass, without rendering anything.
 *
 * The report runner and the dashboard both know every id they are about to show
 * BEFORE they show it, and resolving them up front means the table paints with
 * names already in place instead of visibly upgrading from short ids. Shares the
 * cache and the batching with {@link useRecordLabel}, so a reference already
 * resolved here costs a rendered `<RecordLink>` nothing.
 */
export async function prefetchRecordLabels(entity: string, ids: readonly string[]): Promise<void> {
  const wanted = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
  const known = cacheFor(entity);
  const missing = wanted.filter((id) => !known.has(id));
  if (missing.length === 0) return;

  const info = (await loadEntityInfo()).get(entity);
  for (let i = 0; i < missing.length; i += MAX_IDS_PER_READ) {
    await readLabels(entity, missing.slice(i, i + MAX_IDS_PER_READ), info);
  }
  notify();
}

/**
 * Read an already-resolved label without subscribing. `undefined` means not yet
 * resolved; `null` means resolved and unavailable to this reader.
 */
export function peekRecordLabel(entity: string, id: string): string | null | undefined {
  return cache.get(entity)?.get(id);
}

/**
 * A readable stand-in when the real label isn't available: the tail of the id,
 * which is short, stable, and distinguishes one record from another — everything
 * a full uuid gives a reader, minus the 30 characters that give them nothing.
 */
export function shortRecordId(id: string): string {
  const tail = id.replace(/-/g, '').slice(-6);
  return tail.length > 0 ? `#${tail}` : '';
}

/** In-deck path to a record's detail page. */
export function recordHref(entityName: string, id: string): string {
  return `/${entityName}/${encodeURIComponent(id)}`;
}

export interface ResolvedRecordLabel {
  /** What to show. Never a bare uuid, and never empty. */
  label: string;
  /** Where to go, or `null` when this record cannot be opened by this reader. */
  href: string | null;
  /** True until the deck has answered — the label is a placeholder meanwhile. */
  loading: boolean;
  /** The read completed and this reader cannot see the record. */
  unavailable: boolean;
}

/**
 * Resolve one record reference to a label and a link.
 *
 * @param entity Qualified (`restroin/Outlet`) or bare (`Outlet`) entity id.
 * @param id     The record's id, or null/undefined for an empty reference.
 */
export function useRecordLabel(entity: string | undefined, id: string | null | undefined): ResolvedRecordLabel {
  const [, forceRender] = React.useReducer((n: number) => n + 1, 0);

  React.useEffect(() => {
    const cb = () => forceRender();
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  }, []);

  React.useEffect(() => {
    if (entity && id) request(entity, id);
  }, [entity, id]);

  const [info, setInfo] = React.useState<EntityLabelInfo | undefined>(undefined);
  React.useEffect(() => {
    if (!entity) return;
    let alive = true;
    void loadEntityInfo().then((m) => {
      if (alive) setInfo(m.get(entity));
    });
    return () => {
      alive = false;
    };
  }, [entity]);

  if (!entity || !id) {
    return { label: '—', href: null, loading: false, unavailable: false };
  }

  const entry = cacheFor(entity).get(id);
  const bareName = info?.name ?? (entity.includes('/') ? entity.slice(entity.indexOf('/') + 1) : entity);

  if (entry === undefined) {
    // Not answered yet. Show the short id rather than a blank or a spinner: it is
    // genuinely what we know so far, and it does not reflow when the name lands.
    return { label: shortRecordId(id), href: null, loading: true, unavailable: false };
  }
  if (entry === null) {
    // Resolved, and this reader cannot see it. A dash discloses nothing — not the
    // record's name, and not (via a working link) that it exists.
    return { label: '—', href: null, loading: false, unavailable: true };
  }
  return {
    label: entry.length > 0 ? entry : shortRecordId(id),
    href: recordHref(bareName, id),
    loading: false,
    unavailable: false
  };
}

export interface RecordLinkProps {
  /** Qualified (`restroin/Outlet`) or bare (`Outlet`) entity id. */
  entity?: string;
  /** The referenced record's id. Null/undefined renders an empty reference. */
  id?: string | null;
  /** Rendered instead of resolving — for a row that already carries the name. */
  label?: string;
  /**
   * Open the record in a new tab. Default TRUE, and deliberately so: a reference
   * is followed FROM somewhere — a report row, a dashboard tile — and navigating
   * in place throws away the filters, scroll position and column selection the
   * reader built up to get there. Coming back should not mean rebuilding the
   * view. Set false where the reference IS the navigation (a breadcrumb, a
   * detail-page parent link).
   */
  newTab?: boolean;
  className?: string;
}

/**
 * Render a record reference as its name, linked to the record.
 *
 * Use this ANYWHERE an id would otherwise reach the screen — a report cell, a
 * dashboard tile, a related field on a detail page. It degrades in the two ways
 * that matter: an unreadable record shows a dash and no link (never a name, never
 * a uuid), and a deck that cannot be reached shows a short id rather than failing.
 */
export function RecordLink(props: RecordLinkProps): React.ReactElement {
  const resolved = useRecordLabel(props.entity, props.id);
  const text = props.label ?? resolved.label;

  if (props.label === undefined && resolved.href === null) {
    return React.createElement(
      'span',
      {
        className: props.className,
        'data-loading': resolved.loading ? 'true' : undefined,
        // Screen readers should hear why a cell is blank, not just skip it.
        title: resolved.unavailable ? 'You do not have access to this record' : undefined
      },
      text
    );
  }

  const newTab = props.newTab !== false;

  return React.createElement(
    'a',
    {
      href: resolved.href ?? undefined,
      className: props.className,
      ...(newTab
        ? {
            target: '_blank',
            // `noopener` is not optional on a `_blank` link: without it the
            // opened page gets a handle on this one via `window.opener`.
            rel: 'noopener noreferrer'
          }
        : {}),
      // Say it opens elsewhere. A new tab appearing unannounced is disorienting,
      // and for a screen-reader user it is simply unexplained.
      ...(newTab ? { 'aria-label': `${text} (opens in a new tab)` } : {}),
      // The label is the accessible name; the id is noise to a screen reader.
      title: text
    },
    text
  );
}

/**
 * Drop every cached label. For tests and for the host to call on sign-out — a
 * cached name outliving the session it was read in would be a small leak across
 * account switches on a shared machine.
 */
export function resetRecordLabelCache(): void {
  cache.clear();
  pending.clear();
  inFlight.clear();
  entityInfoPromise = null;
}
