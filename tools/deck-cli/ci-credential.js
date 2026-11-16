/**
 * tools/deck-cli/ci-credential.js — the bearer a deck verb sends to the platform's /internal routes.
 *
 * Two credentials, in this order:
 *   1. The platform key, when the verb's key variable is set (DEPLOY_API_KEY, REGISTRY_API_KEY):
 *      platform automation, or a person at a terminal. A set key always wins.
 *   2. Otherwise, inside a GitHub Actions job granted `id-token: write`: a GitHub OIDC token minted
 *      for this deck — audience `SLUG.deploy.xdeck.in` — which the platform binds to the deck's linked
 *      repository. A deck repository holds no key at all.
 * Neither → an error naming both.
 *
 * The token is returned to the caller for its Authorization header and never printed.
 */
'use strict';

/** The audience a deck's CI token is minted for. The server asks its verifier for the same (deckCiAudience). */
function deckCiAudience(slug) {
  return `${slug}.deploy.xdeck.in`;
}

/** Which credential `env` offers for the verb that reads `keyEnv`: 'key', 'github-oidc', or null for neither. */
function credentialSource(env, keyEnv) {
  if (typeof env[keyEnv] === 'string' && env[keyEnv] !== '') return 'key';
  if (env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) return 'github-oidc';
  return null;
}

/** The message for "no credential", naming both ways to provide one. */
function missingCredentialMessage(keyEnv) {
  return (
    `No credential: set ${keyEnv} (the platform key — platform automation, or a person), or run inside ` +
    'a GitHub Actions job granted `permissions: id-token: write`, where ACTIONS_ID_TOKEN_REQUEST_URL and ' +
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN are set (a deck repository’s CI).'
  );
}

/**
 * The bearer for a request about deck `slug`: `{ kind: 'key' | 'github-oidc', bearer }`. Throws when
 * neither credential is offered, or when GitHub does not hand out a token. `fetchImpl` is injectable
 * so the selection is testable without a network.
 */
async function resolveBearer({ slug, keyEnv, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
  const source = credentialSource(env, keyEnv);
  if (source === 'key') return { kind: 'key', bearer: env[keyEnv] };
  if (source === null) throw new Error(missingCredentialMessage(keyEnv));

  const base = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const url = `${base}${base.includes('?') ? '&' : '?'}audience=${encodeURIComponent(deckCiAudience(slug))}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { Authorization: `bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`, Accept: 'application/json' },
      signal: controller.signal
    });
  } catch (err) {
    throw new Error(`Could not ask GitHub for an OIDC token: ${(err && err.message) || err}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`GitHub refused the OIDC token request (HTTP ${res.status})`);
  let body;
  try {
    body = await res.json();
  } catch (_) {
    throw new Error('GitHub answered the OIDC token request with something that is not JSON');
  }
  if (!body || typeof body.value !== 'string' || body.value === '') {
    throw new Error('GitHub answered the OIDC token request without a token');
  }
  return { kind: 'github-oidc', bearer: body.value };
}

module.exports = { deckCiAudience, credentialSource, missingCredentialMessage, resolveBearer };
