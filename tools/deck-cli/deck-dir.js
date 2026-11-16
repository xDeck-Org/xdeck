/**
 * tools/deck-cli/deck-dir.js — how every deck verb finds the deck it acts on, and names it.
 *
 * The deck is the folder given with `--deck DIR`, or the current directory. Its slug is the
 * `subdomain` its config.json declares: the identity the platform provisions under and that
 * scripts/link-tenants.js reads. A deck whose config.json names none keeps the rule these scripts
 * had while every deck carried its own copy: the folder's own name.
 *
 * Why the config first: a deck repository's folder is named after the repository
 * (`xdeck-tenant-<slug>`), and a CI checkout of it sits in whatever folder the workflow chose, so a
 * folder-name slug pointed the deploy and the release tag at a deck that does not exist.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** The platform's slug shape: lowercase letters, digits and hyphens, 1-50 characters. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;

/** The deck folder: `--deck` resolved against the current directory, or the current directory. */
function deckDir(value, cwd = process.cwd()) {
  return path.resolve(cwd, value === undefined || value === null || value === '' ? '.' : value);
}

/**
 * The deck's slug: config.json's `subdomain` when it is a non-empty string, else the folder's name.
 * Callers check the result against SLUG_RE before it reaches a URL or a tag. A config.json that is
 * missing or does not parse falls back to the folder's name here; validate.js reports the file itself.
 */
function deckSlug(dir) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    if (config && typeof config.subdomain === 'string' && config.subdomain !== '') return config.subdomain;
  } catch (_) {
    // No readable config.json: the folder's name, as before.
  }
  return path.basename(dir);
}

module.exports = { SLUG_RE, deckDir, deckSlug };
