'use strict';

const fs = require('fs');
const path = require('path');

const RC_NAME = '.agentlinkrc';

/**
 * Load .agentlinkrc from CWD → HOME, first found wins.
 * Returns plain object (empty if no rc found).
 */
function loadRC() {
  const candidates = [
    path.join(process.cwd(), RC_NAME),
    path.join(process.env.HOME || '/tmp', RC_NAME),
  ];
  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      return JSON.parse(raw);
    } catch { /* skip */ }
  }
  return {};
}

/**
 * Resolve a room ID through aliases.
 * If `id` matches an alias key, return the mapped value; otherwise return `id` as-is.
 */
function resolveAlias(rc, id) {
  if (!id || !rc.aliases) return id;
  return rc.aliases[id] || id;
}

module.exports = { loadRC, resolveAlias, RC_NAME };
