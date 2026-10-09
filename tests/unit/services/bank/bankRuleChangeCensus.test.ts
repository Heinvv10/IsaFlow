/**
 * Bank-rule change control (forensic-controls step 2; Hein's decision 3): the
 * census that keeps every rule write behind bankRuleChangeControl. Migration
 * 877 records history and refuses an unapproved auto-posting write whoever
 * writes, but only the control HOLDS a change (and answers pending) instead of
 * failing closed with a 500 — so a new writer of bank_categorisation_rules,
 * of a held change, of a decision, or of the declared change kind fails here
 * until it is classified. Agents propose, never decide: no MCP tool reaches a
 * decision. And 877's floor role lists rank on the same ladder as the
 * TypeScript (APPROVER_RANK). Walks src/pages/scripts on disk, comments stripped.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { APPROVER_RANK } from '@/modules/accounting/services/gl/approvalRank';
import { BANK_CONTROL_FLOOR } from '@/modules/accounting/services/bank/bankControlRefusal';

const ROOT = path.resolve(__dirname, '../../../..');
const ROOTS = ['src', 'pages', 'lib'];
const SOURCE = /\.(ts|tsx|js|mjs|cjs)$/;
const BANK = 'src/modules/accounting/services/bank/';
const CONTROL = `${BANK}bankRuleChangeControl.ts`;
const DECISION = `${BANK}bankRuleChangeDecision.ts`;

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE.test(entry.name)) out.push(full);
  }
}

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
const files = (() => {
  const all: string[] = [];
  for (const root of ROOTS) walk(path.join(ROOT, root), all);
  return all.map((f) => ({ file: path.relative(ROOT, f).split(path.sep).join('/'), text: strip(readFileSync(f, 'utf8')) }))
    .sort((x, y) => x.file.localeCompare(y.file));
})();
const matching = (re: RegExp) => files.filter((f) => re.test(f.text)).map((f) => f.file);
/** A write statement naming the table, bare, schema-qualified or quoted. */
const writes = (table: string, ops = 'INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?|MERGE\\s+INTO|COPY') =>
  new RegExp(`\\b(?:${ops})\\s+(?:ONLY\\s+)?(?:"?public"?\\.)?"?${table}"?(?![\\w])`, 'i');

describe('who writes bank_categorisation_rules', () => {
  it('only the change control (the merge re-point included)', () => {
    expect(matching(writes('bank_categorisation_rules'))).toEqual([CONTROL]);
  });

  it('the census sees a writer however it spells the table', () => {
    for (const sql of ['UPDATE bank_categorisation_rules SET', 'DELETE FROM public.bank_categorisation_rules', 'insert into "bank_categorisation_rules"(',
      'TRUNCATE TABLE bank_categorisation_rules']) expect(writes('bank_categorisation_rules').test(sql), sql).toBe(true);
    expect(writes('bank_categorisation_rules').test('UPDATE bank_categorisation_rules_x SET')).toBe(false);
  });

  it('customer merge re-points rules only through the control, before its other writes', () => {
    const merge = files.find((f) => f.file === 'src/modules/accounting/services/ar/customerMergeService.ts')!.text;
    expect(matching(/\bmoveRulesToCustomer\(/)).toEqual(['src/modules/accounting/services/ar/customerMergeService.ts', CONTROL]);
    const at = merge.indexOf('await moveRulesToCustomer(tx, companyId, sourceId, targetId);');
    expect(at).toBeGreaterThan(merge.indexOf('await refuseOrLock(tx, companyId, sourceId, targetId);'));
    expect(at).toBeLessThan(merge.indexOf('await moveDocuments(tx, companyId, sourceId, targetId, mergedBy);'));
  });

  it('only the control declares a change kind (seed / merge) for the history trigger', () => {
    expect(matching(/isaflow\.bank_rule_change_kind/)).toEqual([CONTROL]);
  });
});

describe('held changes and decisions', () => {
  it('a held change is written only by the control; a decision only by the decision module', () => {
    expect(matching(writes('bank_rule_changes'))).toEqual([CONTROL]);
    expect(matching(writes('bank_rule_change_decisions'))).toEqual([DECISION]);
    expect(matching(/bank_rule_change_apply\(/)).toEqual([DECISION]);
  });

  it('only the cookie-session route decides; no MCP tool reaches a decision', () => {
    expect(matching(/\bdecideRuleChange\(/)).toEqual(['pages/api/accounting/bank-rule-changes.ts', DECISION]);
    expect(files.filter((f) => f.file.startsWith('src/lib/mcp/')
      && /decideRuleChange|bankRuleChangeDecision|bank_rule_change_decisions|bank-rule-changes/.test(f.text)).map((f) => f.file)).toEqual([]);
  });

  it('the classification is asked of the database, never re-implemented', () => {
    expect(matching(/bank_rule_change_needs_approval/)).toEqual([CONTROL]);
  });
});

describe('rule writers and switching auto-post on serialise (bankRuleAutoPostLock)', () => {
  const LOCK = `${BANK}bankRuleAutoPostLock.ts`;
  const SETTINGS = `${BANK}autoPostSettingsService.ts`;
  const text = (f: string) => files.find((x) => x.file === f)!.text;
  const body = (f: string, fn: string) => { const t = text(f); const i = t.indexOf(`function ${fn}(`); return t.slice(i, t.indexOf('\n}\n', i)); };

  it('exactly the control takes the shared lock, exactly the settings writer the exclusive one', () => {
    expect(matching(/\blockForRuleWrite\(/)).toEqual([LOCK, CONTROL]);
    expect(matching(/\blockOutRuleWriters\(/)).toEqual([SETTINGS, LOCK, 'src/modules/accounting/services/gl/approvalEnforcement.ts']);
    expect(matching(/bank_rule_unreviewed_changes/)).toEqual([LOCK]);
  });

  it('each writer that can apply a change takes the shared lock before it reads or locks a rule', () => {
    for (const fn of ['writeNewRule', 'writeRuleChange', 'seedRules', 'moveRulesToCustomer']) {
      const b = body(CONTROL, fn);
      const lock = b.indexOf('await lockForRuleWrite(companyId)');
      expect(lock, fn).toBeGreaterThan(0);
      for (const first of ['classify(', 'lockRuleProjection(', 'bank_categorisation_rules']) {
        if (b.includes(first)) expect(lock, `${fn}: lock before ${first}`).toBeLessThan(b.indexOf(first));
      }
    }
  });

  it('switching bank_rule on takes the exclusive lock before it inserts the switch (its enabled_at is a cutoff)', () => {
    const b = body('src/modules/accounting/services/gl/approvalEnforcement.ts', 'enableEnforcement');
    const lock = b.indexOf('await lockOutRuleWriters(companyId)');
    expect(lock).toBeGreaterThan(b.indexOf('if (documentType === BANK_RULE)'));
    expect(lock).toBeLessThan(b.indexOf('INSERT INTO approval_enforcement'));
  });

  it('the settings writer takes the exclusive lock before the row lock, and checks before it writes', () => {
    const b = body(SETTINGS, 'applyOnce');
    expect(b.indexOf('await lockOutRuleWriters(companyId)')).toBeGreaterThan(0);
    expect(b.indexOf('await lockOutRuleWriters(companyId)')).toBeLessThan(b.indexOf('FOR UPDATE'));
    expect(b.indexOf('assertNoUnreviewedRuleChanges(')).toBeLessThan(b.indexOf('UPDATE bank_auto_post_settings'));
  });
});

describe('the database guards rank on the same ladder', () => {
  const sql = readFileSync(path.join(ROOT, 'scripts/migrations/sql/877_bank_controls_step2.sql'), 'utf8');

  it("877's bank_control_rank is APPROVER_RANK, role for role", () => {
    const body = sql.slice(sql.indexOf('FUNCTION public.bank_control_rank('), sql.indexOf('END\n$$;', sql.indexOf('FUNCTION public.bank_control_rank(')));
    const ladder = Object.fromEntries([...body.matchAll(/WHEN '([a-z_]+)' THEN (\d+)/g)].map((m) => [m[1]!, Number(m[2])]));
    expect(ladder).toEqual(APPROVER_RANK);
  });

  it('every role comparison in 877 goes through that ladder (no hand-written role list), the floor is admin', () => {
    expect(sql).not.toMatch(/IN \('super_admin'/);
    expect(sql).not.toMatch(/\brole\s+IN\s*\(/i);
    expect(BANK_CONTROL_FLOOR).toBe('admin');
    expect(sql).toMatch(/COALESCE\(public\.bank_control_rank\(e ->> 'role'\), 0\) >= public\.bank_control_rank\('admin'\)/);
  });
});
