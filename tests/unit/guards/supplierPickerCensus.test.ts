/**
 * PUR-01 census — a source-text RATCHET ONLY. It proves nothing about behaviour:
 * it can only notice a new bare caller. The real proof is behavioural:
 * tests/unit/components/supplierSelect.test.tsx (supplier #26 reachable, required
 * enforced, StrictMode, unknown id) and supplierFormPayloads.test.tsx (each form
 * refuses to POST without a supplier and sends the picked id).
 *
 * /api/accounting/suppliers-list answers 25 rows unless told otherwise, so a
 * caller that fetches it bare and renders the result as a picker silently
 * drops every supplier past the 25th. Every client call to the route must
 * therefore either search server-side (`q=`), resolve one row (`id=`), or page
 * to the end (`page=`) — or be a write/paged-list call listed below with the
 * reason it is safe. Read from disk (not git ls-files) so an untracked new
 * caller cannot pass falsely.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');

const ALLOWED: Record<string, string> = {
  'src/components/accounting/suppliers/DrcFlagToggle.tsx': 'PATCH of one supplier, no list read',
  'pages/accounting/suppliers/new.tsx': 'POST create, no list read',
  'src/components/accounting/createEntity/entityRequests.ts': 'POST create URL for the bank page modal, no list read',
  'src/components/accounting/supplier-invoices/SupplierTypeahead.tsx':
    'the bare ?limit=25 is only the first suggestions; typing switches to ?q= in the same file',
  'pages/accounting/suppliers/index.tsx': 'the suppliers list page: builds ?page=/limit/q params and pages through the total',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Quoted route strings on non-comment lines, e.g. '/api/accounting/suppliers-list?x' */
function routeCalls(src: string): string[] {
  return src.split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .flatMap((l) => l.match(/['"`][^'"`]*suppliers-list[^'"`]*['"`]/g) ?? []);
}

describe('suppliers-list callers are not capped at the 25-row default', () => {
  it('every caller searches (q=), resolves (id=) or pages (page=), or is allow-listed', () => {
    const offenders: string[] = [];
    for (const abs of [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'pages'))]) {
      const rel = relative(ROOT, abs);
      if (rel === 'pages/api/accounting/suppliers-list.ts' || rel in ALLOWED) continue;
      for (const call of routeCalls(readFileSync(abs, 'utf8'))) {
        if (!/[?&](q|id|page)=/.test(call)) offenders.push(`${rel}: ${call}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the allow-list has no stale entries', () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(routeCalls(readFileSync(join(ROOT, rel), 'utf8')).length, rel).toBeGreaterThan(0);
    }
  });
});

/**
 * `/api/accounting/suppliers` (no `-list`) is not a route: two pickers loaded
 * their supplier list from it with `?limit=500` and got a 404, so they were
 * always empty. Only suppliers-list serves suppliers. If someone adds the route,
 * this fails so its cap and callers get the same census as suppliers-list.
 */
describe('nothing reads a /api/accounting/suppliers route that does not exist', () => {
  it('no client call targets it', () => {
    const offenders: string[] = [];
    for (const abs of [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'pages'))]) {
      const rel = relative(ROOT, abs);
      if (rel.startsWith('pages/api/')) continue;
      const hits = readFileSync(abs, 'utf8').split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .flatMap((l) => l.match(/['"`]\/api\/accounting\/suppliers(?:[?/][^'"`]*)?['"`]/g) ?? []);
      for (const h of hits) offenders.push(`${rel}: ${h}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the route is still absent (if it appears, extend this census to it)', () => {
    expect(existsSync(join(ROOT, 'pages/api/accounting/suppliers.ts'))).toBe(false);
    expect(existsSync(join(ROOT, 'pages/api/accounting/suppliers/index.ts'))).toBe(false);
  });
});
