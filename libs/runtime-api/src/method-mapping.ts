/**
 * §9.50 Phase B Slice 7 — canonical mapping from a worker-side method
 * call (`xdeck.<domain>.<method>(...)`) to the capability the runtime
 * guard checks parent-side.
 *
 * **Why this lives in `@xdeck/runtime-api`.** Both the static analyzer
 * (`CapabilityStaticAnalyzerService`) and the install-time validator
 * (`PackageValidatorService`) consume this; future consumers (CI
 * `validate-on-tag.yml` driver, marketplace docs renderer) will too.
 * Co-locating it with the capability catalogue + manifest validator
 * (Slice 1) means adding a new capability is one mapping entry here
 * plus the matching wrapper/host change — no drift across multiple lib
 * boundaries.
 *
 * **The three kinds of mapping:**
 *  1. `static` — `xdeck.email.send(payload)` → `'email:send'`. The
 *     capability string is fixed regardless of arguments.
 *  2. `parameterized` — `xdeck.entity.read({entityName: 'Patient'})` →
 *     `'entity:read:Patient'`. The capability resource id comes from a
 *     named property in the first argument; the analyzer extracts the
 *     literal value (non-literal → unresolvable).
 *  3. `reserved` — `xdeck.event.emit(...)` / `xdeck.class.invoke(...)`.
 *     Per §9.50.9.1 these are reserved and non-grantable today. The
 *     analyzer still records them as used; the validator (Slice 2's
 *     reservation check) rejects them.
 *
 * **`xdeck.context.<field>`** — reads from the always-available identity
 * context. No capability needed; the analyzer skips any PropertyAccess
 * whose first member is `context`.
 */

import type { Capability, ParameterizedCapabilityFamily, StaticCapability } from './capability';

export type XdeckMethodMapping =
  | { kind: 'static'; capability: StaticCapability }
  | { kind: 'parameterized'; family: ParameterizedCapabilityFamily; argKey: string }
  | { kind: 'reserved'; capability: string };

/**
 * Every `xdeck.<domain>.<method>` shape known to the §9.50 contract.
 * Keys are dotted `<domain>.<method>` strings (the same format
 * `XdeckHostService.handlers` uses on the wire).
 *
 * Adding a method = adding an entry here + the matching wrapper +
 * (for static / parameterized) a dispatch table entry in the host.
 */
export const XDECK_METHOD_MAP = {
  // ── Static — fixed capability per method ───────────────────────────
  'email.send': { kind: 'static', capability: 'email:send' },
  'sms.send': { kind: 'static', capability: 'sms:send' },
  'whatsapp.send': { kind: 'static', capability: 'whatsapp:send' },
  'push.send': { kind: 'static', capability: 'push:send' },
  'notification.send': { kind: 'static', capability: 'notification:send-in-app' },
  'notification.broadcast': { kind: 'static', capability: 'notification:broadcast' },
  'ai.complete': { kind: 'static', capability: 'ai:complete' },
  'ai.embed': { kind: 'static', capability: 'ai:embed' },
  'ai.agentInvoke': { kind: 'static', capability: 'ai:agent-invoke' },
  'ai.knowledgeQuery': { kind: 'static', capability: 'ai:knowledge-query' },
  'template.render': { kind: 'static', capability: 'template:render' },
  'job.schedule': { kind: 'static', capability: 'job:schedule' },
  'job.enqueue': { kind: 'static', capability: 'job:enqueue' },
  'http.fetch': { kind: 'static', capability: 'http:fetch-allowlisted' },
  'webhook.send': { kind: 'static', capability: 'webhook:send' },
  'storage.read': { kind: 'static', capability: 'storage:read' },
  'storage.write': { kind: 'static', capability: 'storage:write' },
  'payment.initiate': { kind: 'static', capability: 'payment:initiate' },

  // ── Parameterized — resource id extracted from first arg ────────────
  'entity.read': { kind: 'parameterized', family: 'entity:read', argKey: 'entityName' },
  'entity.write': { kind: 'parameterized', family: 'entity:write', argKey: 'entityName' },
  'secret.read': { kind: 'parameterized', family: 'secret:read', argKey: 'key' },

  // ── Reserved per §9.50.9.1 — recorded so the analyzer surfaces them ──
  'class.invoke': { kind: 'reserved', capability: 'class:invoke' },
  'event.emit': { kind: 'reserved', capability: 'event:emit' },
  'event.listen': { kind: 'reserved', capability: 'event:listen' }
} as const satisfies Record<string, XdeckMethodMapping>;

export type XdeckMethodName = keyof typeof XDECK_METHOD_MAP;

/**
 * Lookup — returns `null` for unknown methods so the analyzer can surface
 * "called xdeck.frobnicate.foo() which doesn't exist" as a clear error.
 */
export function lookupXdeckMethod(method: string): XdeckMethodMapping | null {
  return (XDECK_METHOD_MAP as Record<string, XdeckMethodMapping>)[method] ?? null;
}

/**
 * Build the full capability string for a method invocation, given the
 * extracted resource id when parameterized. Returns the capability or
 * `null` when the method is unknown.
 *
 * For `reserved` methods this still returns the reserved string — the
 * caller (validator) uses Slice 2's reservation check to reject.
 */
export function capabilityForMethodCall(method: string, resourceId?: string | null): Capability | null {
  const mapping = lookupXdeckMethod(method);
  if (!mapping) return null;
  if (mapping.kind === 'static') return mapping.capability;
  if (mapping.kind === 'reserved') return mapping.capability as Capability;
  // parameterized
  if (!resourceId) return null;
  return `${mapping.family}:${resourceId}` as Capability;
}
