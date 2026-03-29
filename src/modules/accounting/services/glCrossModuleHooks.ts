/**
 * Cross-Module GL Integration Hooks
 * - Asset depreciation → DR Depreciation Expense, CR Accumulated Depreciation
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const ACCOUNTS = {
  ACCUM_DEPRECIATION: '1230',
  DEPRECIATION_EXPENSE: '5800',
} as const;

async function getAccountId(code: string): Promise<string> {
  const rows = (await sql`SELECT id FROM gl_accounts WHERE account_code = ${code} LIMIT 1`) as Row[];
  if (!rows[0]) throw new Error(`GL account ${code} not found`);
  return String(rows[0].id);
}

// ── Asset Depreciation → GL ────────────────────────────────────────────────

export async function postAssetDepreciationToGL(
  companyId: string,
  assetId: string,
  depreciationAmount: number,
  userId: string
): Promise<string | null> {
  try {
    if (depreciationAmount <= 0) return null;

    const asset = (await sql`
      SELECT id, asset_number, name FROM assets WHERE id = ${assetId}
    `) as Row[];

    if (!asset[0]) {
      log.warn('Asset not found for depreciation GL', { assetId }, 'accounting');
      return null;
    }

    const depExpenseId = await getAccountId(ACCOUNTS.DEPRECIATION_EXPENSE);
    const accumDepId = await getAccountId(ACCOUNTS.ACCUM_DEPRECIATION);

    const entry = (await sql`
      INSERT INTO gl_journal_entries (
        company_id, entry_number, entry_date, description, source, status, created_by
      ) VALUES (
        ${companyId}, ${`DEP-${asset[0].asset_number}-${new Date().toISOString().slice(0, 7)}`}, CURRENT_DATE,
        ${`Depreciation: ${asset[0].name} (${asset[0].asset_number})`},
        'auto_depreciation', 'posted', ${userId}
      ) RETURNING id
    `) as Row[];

    const entryId = String(entry[0].id);

    await sql`
      INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description)
      VALUES (${entryId}::UUID, ${depExpenseId}::UUID, ${depreciationAmount}, 0,
        ${`Depreciation: ${asset[0].asset_number}`})
    `;
    await sql`
      INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description)
      VALUES (${entryId}::UUID, ${accumDepId}::UUID, 0, ${depreciationAmount},
        ${`Depreciation: ${asset[0].asset_number}`})
    `;

    await sql`
      UPDATE assets SET
        accumulated_depreciation = COALESCE(accumulated_depreciation, 0) + ${depreciationAmount},
        current_book_value = COALESCE(purchase_price, 0) - (COALESCE(accumulated_depreciation, 0) + ${depreciationAmount}),
        updated_at = NOW()
      WHERE id = ${assetId}
    `;

    log.info('Asset depreciation GL posted', { assetId, entryId, depreciationAmount }, 'accounting');
    return entryId;
  } catch (err) {
    log.error('Failed to post asset depreciation to GL', { assetId, error: err }, 'accounting');
    return null;
  }
}
