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
  // A handful of routes write the audit row directly rather than through the
  // service; the action literal is the second VALUES column there too.
  const insertRe = /INSERT INTO admin_audit_log[\s\S]{0,400}?VALUES\s*\([\s\S]{0,200}?,\s*'([A-Za-z0-9_.]+)'/g;
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      const src = readFileSync(file, 'utf8');
      for (const action of callSiteActions(src)) found.add(action);
      if (src.includes('INSERT INTO admin_audit_log')) {
        insertRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = insertRe.exec(src)) !== null) found.add(m[1]!);
      }
    }
  }
  return found;
}

/**
 * The `action` literal is the SECOND argument of logAdminAction. Finding it by
 * "everything up to the first comma" breaks on a first argument that contains
 * one of its own — `logAdminAction(resolveActor(req, ctx), 'user.suspend', …)`
 * — and the miss is silent: the action drops out of the emitted set and a real
 * CRITICAL entry then looks orphaned. So walk the argument list and split it on
 * the first comma at depth zero instead.
 */
function callSiteActions(src: string): string[] {
  const out: string[] = [];
  const CALL = 'logAdminAction(';
  for (let at = src.indexOf(CALL); at !== -1; at = src.indexOf(CALL, at + 1)) {
    const second = secondArgument(src, at + CALL.length);
    const literal = second && /^(['"`])([A-Za-z0-9_.]+)\1$/.exec(second.trim());
    if (literal) out.push(literal[2]!);
  }
  return out;
}

/** The text of the second argument, or null if the call does not have one. */
function secondArgument(src: string, from: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  let argStart: number | null = null;
  for (let i = from; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if ('([{'.includes(ch)) { depth++; continue; }
    if (')]}'.includes(ch)) {
      if (depth === 0) return argStart === null ? null : src.slice(argStart, i);
      depth--;
      continue;
    }
    if (ch === ',' && depth === 0) {
      if (argStart === null) { argStart = i + 1; continue; }
      return src.slice(argStart, i);
    }
  }
  return null;
}

describe('CRITICAL_ACTIONS', () => {
  it('names only actions that some call site actually emits', () => {
    const emitted = emittedActions();
    // Guard the guard: if the scan finds nothing the assertion below is vacuous.
    expect(emitted.size).toBeGreaterThan(20);

    const orphaned = [...CRITICAL_ACTIONS].filter((a) => !emitted.has(a)).sort();
    expect(orphaned).toEqual([]);
  });

  it('finds the action even when the first argument contains a comma', () => {
    // The regex this scan used to run ([^,]{0,200} before the comma) misses
    // both of these, which would silently shrink the emitted set.
    expect(callSiteActions(
      "logAdminAction(resolveActor(req, ctx), 'user.suspend', 'user', id, null, ip);",
    )).toEqual(['user.suspend']);
    expect(callSiteActions(
      'logAdminAction(`actor,${id}`, "flow.adjust", "company", c, null, ip);',
    )).toEqual(['flow.adjust']);
    // A call with no second argument yields nothing rather than throwing.
    expect(callSiteActions('logAdminAction(actorOnly);')).toEqual([]);
  });

  it('covers the privileged writes that must never commit unaudited', () => {
    for (const action of [
      'user.suspend',
      'user.delete',
      'company.create',
      'company.delete',
      'impersonation_start',
      'subscription.create',
      'trial.convert_to_paid',
      'plan.create',
      'flow.adjust',
      'invoice.mark_paid',
      'company_feature.override_set',
      'company_feature.override_removed',
    ]) {
      expect(CRITICAL_ACTIONS.has(action)).toBe(true);
    }
  });
});
