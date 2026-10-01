// Ported from the adversarial round's second pass on PR #593 at 031cd38ae (brk-593/pass2); each case asserts
// the claim, so it was RED where the breaker broke it. Changes from the breaker's file are marked "Ported note".
// brk-593 pass 2: what onboarding's coa-seed does to the tree the company-create seed built.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { brkFixture, show } from './w2-28-brk593.helpers';
import coaSeed from '../../pages/api/accounting/coa-seed';

const fx = brkFixture('BRK593P2T');
const { CO } = fx;
const snap = async () => (await fx.query(`SELECT a.account_code AS code, a.account_subtype AS sub, a.is_system_account AS sys, a.level,
  (SELECT p.account_code FROM gl_accounts p WHERE p.id = a.parent_account_id) AS parent,
  (SELECT p.account_subtype || CASE WHEN p.is_system_account THEN ':system' ELSE '' END FROM gl_accounts p WHERE p.id = a.parent_account_id) AS parent_role
  FROM gl_accounts a WHERE company_id = $1 ORDER BY 1`, [CO])).rows;

describe('brk-593 pass 2: onboarding tree', () => {
  beforeAll(fx.setup);
  afterAll(fx.teardown);
  it('T1 coa-seed isaflow_standard on a freshly created company keeps the parent of every account the company-create seed wired', async () => {
    await fx.query('SELECT seed_company_chart_of_accounts($1)', [CO]);
    const before = await snap();
    const r = await fx.call(coaSeed, 'POST', '/api/accounting/coa-seed', { template: 'isaflow_standard' });
    const after = await snap();
    const lost = before.filter((b) => b.parent && !after.find((a) => a.code === b.code)?.parent)
      .map((b) => `${b.code}(lvl${b.level}) lost parent ${b.parent} [${b.parent_role ?? 'no subtype'}]`);
    const holderHeadersBefore = [...new Set(before.filter((b) => b.parent_role?.endsWith(':system')).map((b) => `${b.parent}:${b.parent_role}`))];
    show('T1', { status: r.statusCode, withParentBefore: before.filter((b) => b.parent).length, withParentAfter: after.filter((a) => a.parent).length, lost, holderHeadersBefore });
    expect(lost).toEqual([]);
  });
  it('T2 coa-seed on an EMPTY chart (dashboard CoaSeedEmptyState) wires every template parent', async () => {
    await fx.wipe();
    const r = await fx.call(coaSeed, 'POST', '/api/accounting/coa-seed', { template: 'isaflow_standard' });
    const after = await snap();
    const { getTemplateLines } = await import('@/modules/accounting/services/gl/chartOfAccountsImportService');
    const want = (getTemplateLines('isaflow_standard') as { code: string; parentCode?: string }[]).filter((l) => l.parentCode);
    const unwired = want.filter((l) => after.find((a) => a.code === l.code)?.parent !== l.parentCode).map((l) => `${l.code} (template parent ${l.parentCode})`);
    show('T2', { status: r.statusCode, templateLinesWithParent: want.length, unwired });
    expect(unwired).toEqual([]);
  });
});
