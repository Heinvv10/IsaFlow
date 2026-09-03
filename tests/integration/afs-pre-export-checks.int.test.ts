// tests/integration/afs-pre-export-checks.int.test.ts
//
// The pre-export blockers are the last thing between a wrong number and a set
// of annual financial statements filed with CIPC under a customer's signature.
// Both of them structurally could not fail:
//
//   checkBalanceSheetBalances read totalAssets / totalLiabilities / totalEquity
//   from a snapshot that only ever held `lines`. getNumber returned 0 for a
//   missing key, so the check computed |0 - (0 + 0)| = 0 and passed.
//
//   checkClosingCashEqualsBank read closingCash and bankBalance from a snapshot
//   that held `opening` and `closing`. Both read 0, so it passed — and even had
//   the keys existed, both came from the SAME snapshot, so it was the cash flow
//   statement agreeing with itself.
//
// A third blocker is added here: every ledger account carrying a balance must
// be mapped to an AFS line. Statement queries start FROM afs_statement_lines
// and join to afs_account_mappings, so an unmapped account is silently absent
// from the statements — 51% of the largest company's ledger, and 100% of every
// company's today, since afs_account_mappings holds zero rows in production.
//
// These tests assert that a WRONG document is refused, which is the property
// that matters. A blocker that cannot fail is not a blocker.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { runPreExportChecks } from '@/modules/accounting/services/afs/afsPreExportChecks';

const DATABASE_URL = process.env.DATABASE_URL;

const COMPANY = '00000000-0000-0000-0000-0000000000fa';
const DOCUMENT = '00000000-0000-0000-0000-0000000000fb';
const GL_BANK = '00000000-0000-0000-0000-0000000000fc';
const GL_EQUITY = '00000000-0000-0000-0000-0000000000fd';
const FISCAL_YEAR = 2026;

const describeIfDb = DATABASE_URL ? describe : describe.skip;

function check(checks: Awaited<ReturnType<typeof runPreExportChecks>>, label: string) {
  return checks.find((c) => c.label.startsWith(label));
}

describeIfDb('AFS pre-export blockers actually block', () => {
  let admin: Pool;

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes AFS fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await cleanup(admin);

    await admin.query(
      `INSERT INTO companies (id, name, is_active, financial_year_start)
       VALUES ($1, 'Pre-export Fixture', true, 1) ON CONFLICT (id) DO NOTHING`,
      [COMPANY],
    );
    await admin.query(
      `INSERT INTO gl_accounts
         (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
       VALUES
         ($2, $1, 'PX1000', 'Bank',          'asset',  'bank',   'debit',  true),
         ($3, $1, 'PX3000', 'Share Capital', 'equity', 'equity', 'credit', true)
       ON CONFLICT (id) DO NOTHING`,
      [COMPANY, GL_BANK, GL_EQUITY],
    );
    await admin.query(
      `INSERT INTO afs_documents (id, company_id, fiscal_year, document_type, reporting_framework, status)
       VALUES ($1, $2, $3, 'afs', 'ifrs_smes', 'draft') ON CONFLICT (id) DO NOTHING`,
      [DOCUMENT, COMPANY, FISCAL_YEAR],
    );

    // A posted entry, so both accounts carry a balance.
    const { rows } = await admin.query(
      `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by)
       VALUES ($1, 'px-1', '2026-05-01', 'pre-export fixture', 'posted', $1) RETURNING id`,
      [COMPANY],
    );
    const entryId = rows[0].id;
    await admin.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
       VALUES ($1,$2,$3,1000,0), ($1,$2,$4,0,1000)`,
      [COMPANY, entryId, GL_BANK, GL_EQUITY],
    );
  }, 60000);

  afterEachReset();

  afterAll(async () => {
    if (!admin) return;
    await cleanup(admin);
    await admin.end();
  });

  function afterEachReset() {
    beforeEach(async () => {
      if (!admin) return;
      await admin.query('DELETE FROM afs_sections WHERE company_id = $1', [COMPANY]);
    });
  }

  // ── the tie-out ────────────────────────────────────────────────────────────

  it('refuses to export while a ledger account is mapped to no AFS line', async () => {
    const checks = await runPreExportChecks(DOCUMENT, COMPANY, 'ifrs_smes');
    const tieOut = check(checks, 'Every ledger account');

    expect(tieOut?.severity).toBe('blocker');
    expect(tieOut?.passed).toBe(false);
    // Both accounts hold a balance and neither is mapped.
    expect(tieOut?.detail).toMatch(/2 general ledger account/);
    expect(tieOut?.detail).toMatch(/100\.0%/);
  });

  it('passes the tie-out once every account carrying a balance is mapped', async () => {
    await admin.query(
      `INSERT INTO afs_account_mappings (company_id, gl_account_id, afs_line_code)
       VALUES ($1,$2,'BS036'), ($1,$3,'BS042')
       ON CONFLICT DO NOTHING`,
      [COMPANY, GL_BANK, GL_EQUITY],
    );
    try {
      const checks = await runPreExportChecks(DOCUMENT, COMPANY, 'ifrs_smes');
      expect(check(checks, 'Every ledger account')?.passed).toBe(true);
    } finally {
      await admin.query('DELETE FROM afs_account_mappings WHERE company_id = $1', [COMPANY]);
    }
  });

  // ── the balance sheet blocker ──────────────────────────────────────────────

  it('refuses a balance sheet section that carries no totals at all', async () => {
    // This is the exact shape the generator used to store: `lines` only. The
    // old check read three absent keys as 0 and passed.
    await insertSection(admin, 'statement_of_fp', { lines: [] });

    const checks = await runPreExportChecks(DOCUMENT, COMPANY, 'ifrs_smes');
    const bs = check(checks, 'Balance sheet balances');

    expect(bs?.passed).toBe(false);
    expect(bs?.detail).toMatch(/totalAssets/);
  });

  it('refuses a balance sheet that does not balance', async () => {
    await insertSection(admin, 'statement_of_fp', {
      lines: [], totalAssets: 1000, totalLiabilities: 400, totalEquity: 300,
    });

    const checks = await runPreExportChecks(DOCUMENT, COMPANY, 'ifrs_smes');
    const bs = check(checks, 'Balance sheet balances');

    expect(bs?.passed).toBe(false);
    expect(bs?.detail).toMatch(/300\.00/); // the 1000 - 700 difference
  });

  it('passes a balance sheet that balances', async () => {
    await insertSection(admin, 'statement_of_fp', {
      lines: [], totalAssets: 1000, totalLiabilities: 400, totalEquity: 600,
    });

    const checks = await runPreExportChecks(DOCUMENT, COMPANY, 'ifrs_smes');
    expect(check(checks, 'Balance sheet balances')?.passed).toBe(true);
  });

  // ── the cash blocker ───────────────────────────────────────────────────────

  it('refuses when closing cash disagrees with the balance sheet', async () => {
    await insertSection(admin, 'statement_of_fp', {
      lines: [], totalAssets: 1000, totalLiabilities: 400, totalEquity: 600, cash: 250,
    });
    await insertSection(admin, 'cash_flow', { closingCash: 1000 });

    const checks = await runPreExportChecks(DOCUMENT, COMPANY, 'ifrs_smes');
    const cash = check(checks, 'Closing cash');

    expect(cash?.passed).toBe(false);
    expect(cash?.detail).toMatch(/750\.00/);
  });

  it('refuses a cash flow section that carries no closing cash', async () => {
    // The old snapshot shape: opening/closing, neither of which the check read.
    await insertSection(admin, 'statement_of_fp', {
      lines: [], totalAssets: 1000, totalLiabilities: 400, totalEquity: 600, cash: 250,
    });
    await insertSection(admin, 'cash_flow', { opening: 0, closing: 250 });

    const checks = await runPreExportChecks(DOCUMENT, COMPANY, 'ifrs_smes');
    expect(check(checks, 'Closing cash')?.passed).toBe(false);
  });

  it('passes when the two statements agree on cash', async () => {
    await insertSection(admin, 'statement_of_fp', {
      lines: [], totalAssets: 1000, totalLiabilities: 400, totalEquity: 600, cash: 250,
    });
    await insertSection(admin, 'cash_flow', { closingCash: 250 });

    const checks = await runPreExportChecks(DOCUMENT, COMPANY, 'ifrs_smes');
    expect(check(checks, 'Closing cash')?.passed).toBe(true);
  });
});

async function insertSection(
  admin: Pool,
  sectionType: string,
  snapshot: Record<string, unknown>,
): Promise<void> {
  await admin.query(
    `INSERT INTO afs_sections (company_id, document_id, section_type, status, sort_order, data_snapshot)
     VALUES ($1, $2, $3, 'auto_generated', 1, $4::jsonb)`,
    [COMPANY, DOCUMENT, sectionType, JSON.stringify(snapshot)],
  );
}

async function cleanup(admin: Pool): Promise<void> {
  await admin.query('DELETE FROM afs_sections WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM afs_account_mappings WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM afs_documents WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM gl_accounts WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
}
