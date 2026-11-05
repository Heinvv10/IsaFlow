/**
 * check-client-ip: nothing may take the LEFTMOST X-Forwarded-For entry as the client address (pentest H7/H8).
 * Detection logic is in ./clientIpRule.ts (unit-tested); this walks src/ and pages/ and reports.
 *
 * Run: bun scripts/ci/check-client-ip.ts
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findLeftmostForwardedFor } from './clientIpRule';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const files = ['src', 'pages'].flatMap((d) => walk(d)).map((file) => ({ file, text: readFileSync(file, 'utf8') }));
const hits = findLeftmostForwardedFor(files);

if (hits.length > 0) {
  console.error('ERROR: the leftmost X-Forwarded-For entry is client-supplied. Use trustedClientIp() from @/lib/trustedClientIp (records that name a person) or getClientIp() from @/lib/rateLimit (rate limits).');
  for (const h of hits) console.error(`  ${h.file}:${h.line}: ${h.text}`);
  process.exit(1);
}
console.log('OK: no code takes the leftmost X-Forwarded-For entry.');
