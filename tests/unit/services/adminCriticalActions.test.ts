// K-097 (adjacent). BEST_EFFORT_ACTIONS is matched against the `action` string a
// call site passes to logAdminAction, and it is the ONLY escape from
// fail-closed: a name on it lets an admin mutation commit unaudited.
//
// Two ways for that matching to be wrong, and this file guards both:
//
//  1. A name on the list that no `logAdminAction` call site emits. The entry is
//     inert, and the mismatch is invisible. This bit the old CRITICAL_ACTIONS
//     allow-list twice — 'feature.override' / 'feature.remove_override' while
//     the routes emit 'company_feature.override_set' / '…override_removed', and
//     'impersonation_start', which is written by a direct INSERT INTO
//     admin_audit_log and therefore never passes through logAdminAction at all.
//     So the two emission mechanisms are enumerated SEPARATELY: a direct-insert
//     action is not governed by this service and must not count as covered.
//  2. A privileged action smuggled onto the list. Asserted by name below.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { BEST_EFFORT_ACTIONS } from '@/modules/admin/services/auditService';

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

interface Emissions {
  /** Actions passed to logAdminAction — the only ones this service governs. */
  viaService: Set<string>;
  /** Actions written straight into admin_audit_log by a route. */
  viaDirectInsert: Set<string>;
}

function emittedActions(): Emissions {
  const viaService = new Set<string>();
  const viaDirectInsert = new Set<string>();
  // A handful of routes write the audit row directly rather than through the
  // service; the action literal is the second VALUES column there too.
  const insertRe = /INSERT INTO admin_audit_log[\s\S]{0,400}?VALUES\s*\([\s\S]{0,200}?,\s*'([A-Za-z0-9_.]+)'/g;
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      const src = readFileSync(file, 'utf8');
      for (const action of callSiteActions(src)) viaService.add(action);
      if (src.includes('INSERT INTO admin_audit_log')) {
        insertRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = insertRe.exec(src)) !== null) viaDirectInsert.add(m[1]!);
      }
    }
  }
  return { viaService, viaDirectInsert };
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

describe('BEST_EFFORT_ACTIONS', () => {
  it('names only actions that a logAdminAction call site actually emits', () => {
    const { viaService } = emittedActions();
    // Guard the guard: if the scan finds nothing the assertion below is vacuous.
    expect(viaService.size).toBeGreaterThan(20);

    const inert = [...BEST_EFFORT_ACTIONS].filter((a) => !viaService.has(a)).sort();
    expect(inert).toEqual([]);
  });

  it('does not count a direct INSERT INTO admin_audit_log as covered', () => {
    const { viaService, viaDirectInsert } = emittedActions();
    // impersonate.ts writes this row itself, so logAdminAction never sees the
    // name and putting it on either list decides nothing. If that route is ever
    // moved onto the service, this expectation is the thing that notices.
    expect(viaDirectInsert.has('impersonation_start')).toBe(true);
    expect(viaService.has('impersonation_start')).toBe(false);
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

  it('never exempts a privileged write from the audit requirement', () => {
    // The first block was on the old CRITICAL_ACTIONS allow-list; the second
    // was not, and is exactly what an allow-list gets wrong — each of these
    // moves money, reprices billing, grants free paid service, or grants and
    // revokes access to a tenant's books.
    for (const action of [
      'user.suspend', 'user.delete', 'user.reset_password',
      'company.create', 'company.delete', 'company.suspend',
      'subscription.create', 'subscription.cancel', 'trial.convert_to_paid',
      'plan.create', 'plan.update', 'flow.adjust', 'invoice.mark_paid',
      'company_feature.override_set', 'company_feature.override_removed',

      'flow.bundle.create', 'flow.bundle.update', 'flow.bundle.deactivate',
      'invoice.create', 'invoice.send',
      'trial.extend', 'trial.bulk_extend', 'company.extend_trial',
      'user.add_to_company', 'user.remove_from_company', 'user.activate',
      'flow.eligibility', 'feature_flag.update',
    ]) {
      expect(BEST_EFFORT_ACTIONS.has(action)).toBe(false);
    }
  });
});
