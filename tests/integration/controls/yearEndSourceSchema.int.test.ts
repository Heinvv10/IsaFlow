import { afterAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { fixtureConfigFromEnv } from '../../../scripts/forensic/fixture-bootstrap';
import { validateFixtureTarget } from '../forensic-fixture';
const target = validateFixtureTarget(fixtureConfigFromEnv(process.env));
const pool = new Pool({ connectionString: target.connectionString, ssl: false, max: 1 });
afterAll(async () => { await pool.end(); });
it('admits controlled year-end source while preserving current accounting sources', async () => {
  const result = await pool.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid=to_regclass('gl_journal_entries') AND conname='gl_journal_entries_source_check'`);
  expect(result.rows).toHaveLength(1);
  for (const source of ['year_end', 'manual', 'auto_invoice', 'auto_payment', 'auto_grn', 'auto_credit_note',
    'auto_bank_recon', 'auto_supplier_invoice', 'auto_supplier_payment', 'auto_write_off', 'auto_adjustment',
    'auto_vat_adjustment', 'auto_batch_payment', 'auto_recurring', 'auto_purchase_order', 'auto_depreciation',
    'auto_payroll', 'auto_migration', 'auto_vat_submission', 'auto_loan_payment', 'auto_expense_claim',
    'auto_bank_transfer', 'auto_asset_disposal', 'auto_asset_expense', 'auto_gl_import', 'auto_expense_receipt']) {
    expect(result.rows[0].definition).toContain(`'${source}'`);
  }
});
