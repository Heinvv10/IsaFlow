#!/usr/bin/env bun
/**
 * Audits migration filenames for duplicate numeric prefixes.
 * Exits 0 — informational only. Prints WARNING for any NEW duplicates
 * (not in the historical allowlist).
 *
 * Usage: bun scripts/audit-migration-naming.ts
 */
import { readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(import.meta.dir, 'migrations', 'sql');

// Historical duplicate-prefix pairs — these pre-date the naming policy.
// Do NOT add new entries here; fix the naming instead.
const KNOWN_DUPLICATE_PREFIXES = new Set(['341', '342', '343', '344', '434', '436', '437']);

const files = readdirSync(MIGRATIONS_DIR)
  .filter(f => f.endsWith('.sql'))
  .sort();

// Group by the full prefix string — digits followed by an optional letter,
// e.g. "244" or "244b". Files like 244_ and 244b_ are distinct prefixes
// and are NOT flagged. Only two files sharing the exact same prefix are violations.
const byPrefix = new Map<string, string[]>();
for (const file of files) {
  const match = /^(\d+[a-z]?)_/.exec(file);
  if (!match) {
    console.warn(`WARNING: non-standard filename: ${file}`);
    continue;
  }
  const prefix = match[1]!;
  const group = byPrefix.get(prefix) ?? [];
  group.push(file);
  byPrefix.set(prefix, group);
}

let newViolations = 0;
for (const [prefix, group] of byPrefix) {
  if (group.length > 1) {
    // Strip trailing letter to get the numeric-only prefix for allowlist lookup
    const numericPrefix = prefix.replace(/[a-z]+$/, '');
    if (KNOWN_DUPLICATE_PREFIXES.has(numericPrefix)) {
      console.log(`OK (historical): prefix ${prefix} — ${group.join(', ')}`);
    } else {
      console.warn(`WARNING: NEW duplicate prefix ${prefix} — ${group.join(', ')}`);
      newViolations++;
    }
  }
}

const total = files.length;
console.log(`\nScanned ${total} migration files.`);
if (newViolations === 0) {
  console.log('No new duplicate prefixes found.');
} else {
  console.warn(`${newViolations} new duplicate prefix(es) found — please rename one file in each pair.`);
}
// Exit 0 always — informational, does not fail CI.
process.exit(0);
