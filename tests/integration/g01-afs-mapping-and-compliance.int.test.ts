/**
 * G-01 review round 3 (AFS): what the pre-export check and the compliance checker say about the
 * derived accumulated profit.
 *
 *  - an account mapped to the wrong statement (a revenue account on a balance-sheet line) is counted
 *    twice by the Statement of Financial Position, so the pre-export check NAMES it and the compliance
 *    checker flags the unbalanced SFP (it read `data_snapshot.totals.*`, which the generator never writes,
 *    so it never fired);
 *  - on a taxonomy without BS045 the derived profit lands on its own line (BSACCPL), and the statement of
 *    changes in equity must carry it too, or it stops tying to the SFP.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { newTenant, seedTenant, cleanupTenant } from './helpers/g01Fixture';
import { generateStatementOfFinancialPosition } from '../../src/modules/accounting/services/afs/noteGenerators/primaryStatements/balanceSheet';
import { generateChangesInEquity } from '../../src/modules/accounting/services/afs/noteGenerators/primaryStatements/equity';
import { runPreExportChecks } from '../../src/modules/accounting/services/afs/afsPreExportChecks';
import { runComplianceCheck } from '../../src/modules/accounting/services/afs/complianceCheckerService';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const user = crypto.randomUUID();
const t = newTenant();
const LABEL = 'Every mapped account is on the right statement';

async function sections(): Promise<void> {
  const sfp = await generateStatementOfFinancialPosition(t.company, 2025, 'ifrs_smes');
  const soce = await generateChangesInEquity(t.company, 2025, 'ifrs_smes');
  await pool.query('DELETE FROM afs_sections WHERE document_id=$1', [t.doc]);
  for (const [type, order, gen] of [['statement_of_fp', 1, sfp], ['changes_in_equity', 2, soce]] as const) {
    await pool.query(
      `INSERT INTO afs_sections(document_id,company_id,section_type,sort_order,status,data_snapshot,content)
       VALUES($1,$2,$3,$4,'reviewed',$5::jsonb,$6::jsonb)`,
      [t.doc, t.company, type, order, JSON.stringify(gen.dataSnapshot), JSON.stringify({ ...gen.content, comparativePeriod: '2024' })]);
  }
}

const mathIssues = async () => (await runComplianceCheck(t.company, t.doc)).issues
  .filter((i) => i.category === 'mathematical').map((i) => i.checkId);

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `g01cc-${user}@test.local`]);
  await seedTenant(pool, t, user, 'G01 compliance');
}, 120000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM afs_sections WHERE company_id=$1', [t.company]);
    await cleanupTenant(pool, t);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('a correctly mapped company', () => {
  it('has no misplaced-account finding and a balanced, tying SFP and SOCE', async () => {
    const checks = await runPreExportChecks(t.doc, t.company, 'ifrs_smes');
    expect(checks.find((c) => c.label === LABEL)).toBeUndefined();
    await sections();
    const issues = await mathIssues();
    expect(issues).not.toContain('mathematical.balance_sheet_balances');
    expect(issues).not.toContain('mathematical.equity_closing_balance');
  });
});

describe('a revenue account mapped to a balance-sheet line', () => {
  it('is named by the pre-export check, and the unbalanced SFP is flagged', async () => {
    await pool.query("UPDATE afs_account_mappings SET afs_line_code='BS046' WHERE company_id=$1 AND gl_account_id=$2", [t.company, t.acct.revenue]);
    const finding = (await runPreExportChecks(t.doc, t.company, 'ifrs_smes')).find((c) => c.label === LABEL);
    expect(finding).toMatchObject({ passed: false, severity: 'warning' });
    expect(finding!.detail).toMatch(/4000 Sales \(revenue\) is mapped to BS046, a balance sheet line/);
    await sections();
    expect(await mathIssues()).toContain('mathematical.balance_sheet_balances');
    await pool.query("UPDATE afs_account_mappings SET afs_line_code='IS002' WHERE company_id=$1 AND gl_account_id=$2", [t.company, t.acct.revenue]);
  });

  it('but a mapping on a DEACTIVATED line is not warned about (the SFP does not read it)', async () => {
    await pool.query("UPDATE afs_account_mappings SET afs_line_code='BS046' WHERE company_id=$1 AND gl_account_id=$2", [t.company, t.acct.revenue]);
    await pool.query("UPDATE afs_statement_lines SET is_active=false WHERE company_id=$1 AND code='BS046'", [t.company]);
    const checks = await runPreExportChecks(t.doc, t.company, 'ifrs_smes');
    expect(checks.find((c) => c.label === LABEL)).toBeUndefined();
    await pool.query("UPDATE afs_statement_lines SET is_active=true WHERE company_id=$1 AND code='BS046'", [t.company]);
    await pool.query("UPDATE afs_account_mappings SET afs_line_code='IS002' WHERE company_id=$1 AND gl_account_id=$2", [t.company, t.acct.revenue]);
  });

  it('and a liability account mapped to an income-statement line is named too', async () => {
    await pool.query("UPDATE afs_account_mappings SET afs_line_code='IS002' WHERE company_id=$1 AND gl_account_id=$2", [t.company, t.acct.loan]);
    const finding = (await runPreExportChecks(t.doc, t.company, 'ifrs_smes')).find((c) => c.label === LABEL);
    expect(finding!.detail).toMatch(/2000 Loan \(liability\) is mapped to IS002, an income statement line/);
    await pool.query("UPDATE afs_account_mappings SET afs_line_code='BS054' WHERE company_id=$1 AND gl_account_id=$2", [t.company, t.acct.loan]);
  });

  it('but an equity account mapped to IS484 Dividends paid is not named (the SFP and SOCE carry it)', async () => {
    await pool.query("UPDATE afs_account_mappings SET afs_line_code='IS484' WHERE company_id=$1 AND gl_account_id=$2", [t.company, t.acct.capital]);
    try {
      expect((await runPreExportChecks(t.doc, t.company, 'ifrs_smes')).find((c) => c.label === LABEL)).toBeUndefined();
      await pool.query("UPDATE afs_account_mappings SET afs_line_code='IS002' WHERE company_id=$1 AND gl_account_id=$2", [t.company, t.acct.loan]);
      const detail = (await runPreExportChecks(t.doc, t.company, 'ifrs_smes')).find((c) => c.label === LABEL)!.detail;
      expect(detail).toMatch(/2000 Loan \(liability\) is mapped to IS002/);
      expect(detail).not.toMatch(/3000 Share capital/);
    } finally {
      await pool.query("UPDATE afs_account_mappings SET afs_line_code='BS054' WHERE company_id=$1 AND gl_account_id=$2", [t.company, t.acct.loan]);
      await pool.query("UPDATE afs_account_mappings SET afs_line_code='BS043' WHERE company_id=$1 AND gl_account_id=$2", [t.company, t.acct.capital]);
    }
  });
});

describe('a taxonomy without BS045', () => {
  it('carries the derived profit on BSACCPL in the SFP AND the statement of changes in equity', async () => {
    await pool.query("UPDATE afs_account_mappings SET afs_line_code='BS046' WHERE company_id=$1 AND gl_account_id=$2", [t.company, t.acct.retained]);
    await pool.query("DELETE FROM afs_statement_lines WHERE company_id=$1 AND code='BS045'", [t.company]);
    const sfp = await generateStatementOfFinancialPosition(t.company, 2025, 'ifrs_smes');
    const soce = await generateChangesInEquity(t.company, 2025, 'ifrs_smes');
    const derived = (soce.dataSnapshot.equityLines as Array<{ code: string; currentAmount: number }>).find((l) => l.code === 'BSACCPL');
    expect(derived?.currentAmount).toBe(-1450);
    const snap = sfp.dataSnapshot as { totalAssets: number; totalLiabilities: number; totalEquity: number };
    expect(snap.totalAssets).toBe(snap.totalLiabilities + snap.totalEquity);
    expect(soce.dataSnapshot.closingTotalEquity).toBe(snap.totalEquity);
    await sections();
    const issues = await mathIssues();
    expect(issues).not.toContain('mathematical.balance_sheet_balances');
    expect(issues).not.toContain('mathematical.equity_closing_balance');
  });
});
