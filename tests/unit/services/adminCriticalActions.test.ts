// K-097 (adjacent). CRITICAL_ACTIONS is matched against the `action` string a call site
// passes to logAdminAction. An entry nothing emits protects nothing, and the
// mismatch is invisible: the audit write for a privileged action is simply
// treated as best-effort and its failure swallowed. That is exactly what
// happened to the company feature-flag overrides, which the set named
// 'feature.override' / 'feature.remove_override' while the routes emit
// 'company_feature.override_set' / 'company_feature.override_removed'.
//
// This test enumerates the action literals actually emitted across src/ and
// pages/ — both those passed to logAdminAction and those written straight into
// admin_audit_log — and requires every CRITICAL_ACTIONS entry to be one of
// them.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { CRITICAL_ACTIONS } from '@/modules/admin/services/auditService';

const ROOT = join(__dirname, '..', '..', '..');
const SCAN_DIRS = ['src', 'pages'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function emittedActions(): Set<string> {
  const found = new Set<string>();
  // The action is the second argument; capture the first quoted literal that
  // follows the first comma of the call.
  const callRe = /logAdminAction\s*\(\s*[^,]{0,200},\s*(['"`])([A-Za-z0-9_.]+)\1/g;
  // A handful of routes write the audit row directly rather than through the
  // service; the action literal is the second VALUES column there too.
  const insertRe = /INSERT INTO admin_audit_log[\s\S]{0,400}?VALUES\s*\([\s\S]{0,200}?,\s*'([A-Za-z0-9_.]+)'/g;
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      const src = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      if (src.includes('logAdminAction(')) {
        callRe.lastIndex = 0;
        while ((m = callRe.exec(src)) !== null) found.add(m[2]!);
      }
      if (src.includes('INSERT INTO admin_audit_log')) {
        insertRe.lastIndex = 0;
        while ((m = insertRe.exec(src)) !== null) found.add(m[1]!);
      }
    }
  }
  return found;
}

describe('CRITICAL_ACTIONS', () => {
  it('names only actions that some call site actually emits', () => {
    const emitted = emittedActions();
    // Guard the guard: if the scan finds nothing the assertion below is vacuous.
    expect(emitted.size).toBeGreaterThan(20);

    const orphaned = [...CRITICAL_ACTIONS].filter((a) => !emitted.has(a)).sort();
    expect(orphaned).toEqual([]);
  });

  it('covers the privileged writes that must never commit unaudited', () => {
    for (const action of [
      'user.suspend',
      'company.delete',
      'impersonation_start',
      'company_feature.override_set',
      'company_feature.override_removed',
    ]) {
      expect(CRITICAL_ACTIONS.has(action)).toBe(true);
    }
  });
});
