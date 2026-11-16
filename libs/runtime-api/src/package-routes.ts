/**
 * §9.94 B3 (ADR-0019 D8) — the package-route CONTRACT primitive. Pure,
 * sandbox-agnostic, framework-agnostic types + matchers for the gated package-route
 * surface, shared by the kernel runtime and the manifest validator.
 *
 * **The surface.** A package declares HTTP routes in its manifest (`routes[]`). The
 * kernel mounts ONE catch-all controller at `/api/v1/pkg/<ns>/<name>/*` and owns every
 * security gate — tenant-resolution, session auth + the `UserTenantAccess` membership
 * assertion, isolation, the `route:expose` capability gate, and a fail-CLOSED
 * rate-limit — BEFORE dispatching the matched route to a SANDBOXED handler class method
 * (via `SandboxClassRunner.invokeMethod({ subPath: 'routes' })`). The package supplies
 * only the handler; it never owns a kernel invariant (ADR-0019 D1).
 *
 * **This file is the contract both sides share** — the kernel runtime
 * (controller / guards / dispatcher / route registry) is B3.a-runtime; the manifest
 * AJV schema mirrors {@link PackageRouteManifestEntry} in `@xdeck/shared-types`.
 *
 * Design: adversarially-verified workflow (catch-all-controller approach; the C1
 * cross-tenant-authorization fix + C2 fail-closed rate-limit live in the runtime).
 */

import type { ParameterizedCapabilityFamily } from './capability';

/** HTTP methods a package route may declare. */
export type PackageRouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Auth mode for a package route.
 *  - `'session'` (default) — reached on the tenant SUBDOMAIN behind a logged-in tenant
 *    member (B3.a: JwtAuth → membership → route:expose).
 *  - `'public-hmac'` (B3.c) — a PUBLIC, tenant-agnostic surface (`/runtime/pkg-public/...`)
 *    for server-to-server callers (webhooks). No session; the kernel authenticates each
 *    request by an HMAC-SHA256 over the raw body with the route's per-(tenant,package) vault
 *    secret ({@link PackageRouteManifestEntry.hmacSecretKey}) + a replay window. A route is
 *    served on EXACTLY ONE surface — the auth mode decides which; a mismatch fails closed.
 *  - `'public-binding'` (§9.82.2) — an ANONYMOUS surface on the tenant SUBDOMAIN
 *    (`/api/v1/pkg-open/<ns>/<name>/*`) for signed-binding-carrying callers (a diner who
 *    scanned a printed table QR). The kernel authenticates NOTHING here by design — the
 *    handler MUST verify a §9.50 signed binding (`binding:verify:<kind>`) from its body
 *    before any read/write, which is the actual authorization (scope comes only from the
 *    verified claims; the host's verify is own-tenant-only, so a cross-tenant token fails).
 *    Because the surface is open, a declared `rateLimit` is MANDATORY and the kernel's
 *    fail-closed route throttle always applies; `requiredPermission` is forbidden (there
 *    is no user). Served on exactly one surface like every other mode.
 *  - `'consumer'` (§9.150 B) — an IDENTITY-gated surface on the tenant SUBDOMAIN
 *    (`/api/v1/pkg-consumer/<ns>/<name>/*`) for a ClienX consumer acting on a deck they have
 *    ALREADY engaged (an online-portal order). The kernel verifies a consumer session (the
 *    `ConsumerSessionVerifier` port) and hands the sandboxed handler ONLY the deck-local
 *    `customerLinkId` on `caller` — never the raw ClienX user id or any PII (§9.61: the deck
 *    holds link rows, ClienX is the identity SoR). Like `public-binding` it is consumer-facing,
 *    so a declared `rateLimit` is MANDATORY and `requiredPermission` is forbidden (the caller
 *    is a consumer, not a tenant member). Served on exactly one surface like every other mode.
 */
export type PackageRouteAuth = 'session' | 'public-hmac' | 'public-binding' | 'consumer';

/** A route id: stable per package; becomes the `route:expose` capability resource + grant key. */
export const ROUTE_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
export const HANDLER_CLASS_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
export const HANDLER_METHOD_PATTERN = /^[a-z][a-zA-Z0-9]*$/;
/** §9.94 B3.c — `hmacSecretKey` must be a §9.80 vault key (UPPER_SNAKE). */
export const HMAC_SECRET_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
export const ROUTE_TIMEOUT_DEFAULT_MS = 5_000;
export const ROUTE_TIMEOUT_MAX_MS = 30_000;
export const ROUTE_MAX_PER_PACKAGE = 50;

/** Per-(tenant, package, route) request budget; the kernel clamps to `min(limit, planCeiling)`. */
export interface PackageRouteRateLimit {
  limit: number;
  windowSeconds: number;
}

/**
 * One HTTP route a package exposes under `/api/v1/pkg/<ns>/<name>/`. The handler is a
 * sandboxed class method; the kernel owns every security gate around it.
 */
export interface PackageRouteManifestEntry {
  /** Stable per-package route id — the `route:expose` capability resource. {@link ROUTE_ID_PATTERN}; MUST NOT contain `:` or `/`. */
  id: string;
  method: PackageRouteMethod;
  /** Path under the package prefix, e.g. `/orders/:orderId`. `:param` segments bind into the request envelope. No wildcards, no `..`. */
  path: string;
  /** Handler class under `<scope>/classes/routes/<handlerClass>.ts` (sandbox sub-path `'routes'`). */
  handlerClass: string;
  handlerMethod: string;
  /** Auth mode. Default `'session'`. `'public-hmac'` requires {@link hmacSecretKey}. */
  auth?: PackageRouteAuth;
  /**
   * §9.94 B3.c — REQUIRED when `auth: 'public-hmac'` (ignored otherwise): the §9.50 vault
   * secret KEY (UPPER_SNAKE) holding the HMAC signing secret the kernel verifies inbound
   * requests against. The package author declares the secret as a `settingsSchema` secret
   * field; the tenant sets the value; the external caller is given it out-of-band. The kernel
   * reads it server-side per request — it is NEVER handed to package code.
   */
  hmacSecretKey?: string;
  /** RBAC permission the CALLING user must hold — distinct from the package's own `route:expose` capability. */
  requiredPermission?: string;
  /** Per-route budget; clamped to the plan ceiling by the kernel. */
  rateLimit?: PackageRouteRateLimit;
  /** Wall-clock budget; clamped to {@link ROUTE_TIMEOUT_MAX_MS}. Default {@link ROUTE_TIMEOUT_DEFAULT_MS}. */
  timeoutMs?: number;
  description?: string;
  deprecated?: boolean;
}

/**
 * Kernel → handler envelope (the single `args` object passed to the sandboxed method).
 * Deliberately carries NO bearer token / cookie — identity to ACT ON is `caller`; the
 * handler reads its tenant from the parent-locked `xdeck.context`, never from here.
 */
export interface PackageRouteRequest {
  method: PackageRouteMethod;
  /** The resolved path, e.g. `/orders/abc123`. */
  path: string;
  /** `:param` captures, e.g. `{ orderId: 'abc123' }`. */
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  /** Parsed JSON body — byte-capped by the kernel BEFORE dispatch. */
  body: unknown;
  /** ALLOWLISTED inbound headers — never `Authorization` / `Cookie` / `X-Tenant-*`. */
  headers: Record<string, string>;
  /**
   * The caller's identity to act on — never a token. On the `consumer` surface (§9.150 B)
   * `userId` is the consumer sentinel and `customerLinkId` carries the deck-local §9.61 link
   * id — the ONLY identity a consumer handler ever sees (never the ClienX user id or any PII).
   */
  caller: { userId: string; permissions: string[]; customerLinkId?: string };
}

/** Handler → kernel response; the kernel clamps the status + allowlists headers + caps the body before it touches HTTP. */
export interface PackageRouteResponse {
  status?: number;
  /** ALLOWLISTED keys; `set-cookie` / `authorization` / `location` are dropped by the kernel (no cookie-minting / open-redirect on the tenant's own origin). */
  headers?: Record<string, string>;
  body?: unknown;
}

/** The capability family that gates package-route exposure (re-exported for callers that gate by family). */
export const ROUTE_EXPOSE_FAMILY: Extract<ParameterizedCapabilityFamily, 'route:expose'> = 'route:expose';

/**
 * Build the `route:expose` capability resource string for one route:
 * `route:expose:<namespace>/<name>:<routeId>`. The `<ns>/<name>` is part of the
 * resource so a grant can never be replayed by a different package (same per-resource
 * isolation as `secret:read:<KEY>`).
 */
export function routeExposeCapability(namespace: string, name: string, routeId: string): string {
  return `route:expose:${namespace}/${name}:${routeId}`;
}

/**
 * §9.94 B3.b — derive the full set of `route:expose:<ns>/<name>:<id>` capabilities a
 * package's `routes[]` implies, one per declared route. The install/approval flow folds
 * these into the manifest's OPTIONAL capability set (ADR-0019 D8 / D-a-1) so a tenant
 * can toggle which declared routes go live WITHOUT the author redundantly re-listing each
 * `route:expose:<id>` in `capabilities`. Pure + deterministic (manifest order preserved).
 * A package with no `routes[]` yields `[]`.
 */
export function routeExposeCapabilities(
  namespace: string,
  name: string,
  routes: readonly PackageRouteManifestEntry[] | undefined
): string[] {
  return (routes ?? []).map((r) => routeExposeCapability(namespace, name, r.id));
}

/** §9.94 B3.b — `true` when a capability string is a `route:expose:` grant (cheap prefix test). */
export function isRouteExposeCapability(capability: string): boolean {
  return capability.startsWith('route:expose:');
}

/**
 * A deterministic, canonical serialization of a route's SECURITY-MEANINGFUL declaration
 * — method, normalized path, handler, auth, requiredPermission. The kernel hashes this
 * (via `HashingService`, never ad-hoc crypto) into the grant's `declHash` so that a
 * version upgrade can carry a grant forward ONLY when the declaration is unchanged; a
 * package can never silently repoint an already-approved route id to a different/
 * destructive handler (the tenant approved a BEHAVIOUR, not a name). Pure + stable
 * key order; `rateLimit`/`timeoutMs`/`description`/`deprecated` are NOT included (they
 * are not authorization-relevant and would force needless re-approval).
 */
export function canonicalRouteDeclaration(entry: PackageRouteManifestEntry): string {
  return JSON.stringify([
    entry.method,
    normalizeRoutePath(entry.path),
    entry.handlerClass,
    entry.handlerMethod,
    entry.auth ?? 'session',
    entry.requiredPermission ?? null
  ]);
}

/** Normalize a path for matching/canonicalization: collapse duplicate slashes, strip a trailing slash (except root). */
export function normalizeRoutePath(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed;
}

/**
 * Pure segment matcher: does an incoming sub-path match a declared route template, and
 * what are the `:param` captures? Returns `{ params }` on a match, else `null`.
 *
 * The kernel uses THIS, never the Nest router (the catch-all controller owns matching),
 * so a package route can never shadow a kernel route. Fail-closed against traversal:
 * a `.`/`..` segment or an empty segment in EITHER side returns `null` (no match).
 *
 *  - template `/orders/:orderId`, actual `/orders/abc` → `{ params: { orderId: 'abc' } }`
 *  - segment counts must match exactly (no implicit wildcard / prefix match)
 *  - a literal template segment must equal the actual segment
 */
export function matchRoutePath(template: string, actual: string): { params: Record<string, string> } | null {
  const t = splitSegments(template);
  const a = splitSegments(actual);
  if (t === null || a === null) return null;
  if (t.length !== a.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < t.length; i++) {
    const seg = t[i];
    if (seg.startsWith(':')) {
      const key = seg.slice(1);
      // A `:`-only segment, or a duplicate param name, is a malformed template → no match.
      if (key.length === 0 || Object.prototype.hasOwnProperty.call(params, key)) return null;
      params[key] = a[i];
    } else if (seg !== a[i]) {
      return null;
    }
  }
  return { params };
}

/** Split a path into non-empty segments; returns `null` if any segment is empty or a traversal token. */
function splitSegments(path: string): string[] | null {
  if (typeof path !== 'string' || path.length === 0) return null;
  const parts = path.split('/').filter((s, idx) => !(idx === 0 && s === '')); // drop leading-slash empty
  const segs: string[] = [];
  for (const p of parts) {
    if (p === '') return null; // empty segment (e.g. trailing slash, '//') — reject
    if (p === '.' || p === '..') return null; // traversal — reject
    segs.push(p);
  }
  return segs;
}

/**
 * Validate a manifest route entry's STRUCTURE (the publish-time floor; the runtime
 * validator additionally asserts the handler class/method exist). Returns a list of
 * human-readable error strings — empty means valid.
 */
export function validatePackageRoute(entry: PackageRouteManifestEntry): string[] {
  const errors: string[] = [];
  if (!ROUTE_ID_PATTERN.test(entry.id)) {
    errors.push(`route id '${entry.id}' must match ${ROUTE_ID_PATTERN} (lowercase, no ':' or '/')`);
  }
  if (!(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).includes(entry.method)) {
    errors.push(`route '${entry.id}': invalid method '${entry.method}'`);
  }
  if (splitSegments(entry.path) === null || !entry.path.startsWith('/')) {
    errors.push(`route '${entry.id}': path '${entry.path}' must be a '/'-rooted path with no empty/'.'/'..' segments`);
  }
  if (!HANDLER_CLASS_PATTERN.test(entry.handlerClass)) {
    errors.push(`route '${entry.id}': handlerClass '${entry.handlerClass}' must match ${HANDLER_CLASS_PATTERN}`);
  }
  if (!HANDLER_METHOD_PATTERN.test(entry.handlerMethod)) {
    errors.push(`route '${entry.id}': handlerMethod '${entry.handlerMethod}' must match ${HANDLER_METHOD_PATTERN}`);
  }
  if (
    entry.auth !== undefined &&
    entry.auth !== 'session' &&
    entry.auth !== 'public-hmac' &&
    entry.auth !== 'public-binding' &&
    entry.auth !== 'consumer'
  ) {
    errors.push(
      `route '${entry.id}': auth '${entry.auth}' invalid (must be 'session', 'public-hmac', 'public-binding' or 'consumer')`
    );
  }
  if (entry.auth === 'public-hmac') {
    // A public-hmac route is unauthenticated except for the signature → its signing-secret
    // key is mandatory + must be a valid §9.80 vault key (UPPER_SNAKE), else the route would
    // have no way to authenticate callers.
    if (!entry.hmacSecretKey || !HMAC_SECRET_KEY_PATTERN.test(entry.hmacSecretKey)) {
      errors.push(
        `route '${entry.id}': auth 'public-hmac' requires hmacSecretKey matching ${HMAC_SECRET_KEY_PATTERN} (an UPPER_SNAKE vault key)`
      );
    }
  } else if (entry.hmacSecretKey !== undefined) {
    errors.push(`route '${entry.id}': hmacSecretKey is only valid with auth 'public-hmac'`);
  }
  if (entry.auth === 'public-binding') {
    // An anonymous surface: the ONLY per-caller brake is the kernel throttle, so the
    // author must state a budget explicitly (no silent default on an open door), and
    // there is no user to hold a permission.
    if (!entry.rateLimit) {
      errors.push(`route '${entry.id}': auth 'public-binding' requires an explicit rateLimit`);
    }
    if (entry.requiredPermission !== undefined) {
      errors.push(`route '${entry.id}': requiredPermission is meaningless with auth 'public-binding' (no user)`);
    }
  }
  if (entry.auth === 'consumer') {
    // Identity-gated but consumer-facing (public internet): the kernel throttle is the
    // per-caller brake, so an explicit budget is mandatory (same discipline as
    // 'public-binding'); and a consumer is not a tenant member, so a tenant-RBAC
    // requiredPermission is meaningless here.
    if (!entry.rateLimit) {
      errors.push(`route '${entry.id}': auth 'consumer' requires an explicit rateLimit`);
    }
    if (entry.requiredPermission !== undefined) {
      errors.push(
        `route '${entry.id}': requiredPermission is meaningless with auth 'consumer' (the caller is a consumer, not a tenant member)`
      );
    }
  }
  if (entry.timeoutMs !== undefined && (entry.timeoutMs <= 0 || entry.timeoutMs > ROUTE_TIMEOUT_MAX_MS)) {
    errors.push(`route '${entry.id}': timeoutMs must be in (0, ${ROUTE_TIMEOUT_MAX_MS}]`);
  }
  if (entry.rateLimit && (entry.rateLimit.limit <= 0 || entry.rateLimit.windowSeconds <= 0)) {
    errors.push(`route '${entry.id}': rateLimit.limit and windowSeconds must be positive`);
  }
  return errors;
}

/**
 * Validate a package's whole `routes[]` array: each entry valid, no duplicate ids, and
 * no duplicate `(method, normalizedPath)` (which would make dispatch ambiguous). Returns
 * the flat error list.
 */
export function validatePackageRoutes(routes: readonly PackageRouteManifestEntry[]): string[] {
  const errors: string[] = [];
  if (routes.length > ROUTE_MAX_PER_PACKAGE) {
    errors.push(`a package may declare at most ${ROUTE_MAX_PER_PACKAGE} routes (got ${routes.length})`);
  }
  const seenIds = new Set<string>();
  const seenSigs = new Set<string>();
  for (const r of routes) {
    errors.push(...validatePackageRoute(r));
    if (seenIds.has(r.id)) errors.push(`duplicate route id '${r.id}'`);
    seenIds.add(r.id);
    const sig = `${r.method} ${normalizeRoutePath(r.path)}`;
    if (seenSigs.has(sig)) errors.push(`duplicate route signature '${sig}'`);
    seenSigs.add(sig);
  }
  return errors;
}
