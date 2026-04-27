import type { TaggedSql } from './types';

const COA_TEMPLATE = [
  { code: '1000', name: 'Assets',                   type: 'asset',     normalBalance: 'debit',  level: 1, displayOrder: 100, isSystem: true },
  { code: '1100', name: 'Current Assets',           type: 'asset',     normalBalance: 'debit',  level: 2, displayOrder: 110, parentCode: '1000', isSystem: true },
  { code: '1110', name: 'Business Bank Account',    type: 'asset',     normalBalance: 'debit',  level: 3, displayOrder: 111, parentCode: '1100', subtype: 'bank', isSystem: true },
  { code: '1120', name: 'Accounts Receivable',      type: 'asset',     normalBalance: 'debit',  level: 3, displayOrder: 112, parentCode: '1100', subtype: 'receivable', isSystem: true },
  { code: '1140', name: 'VAT Input',                type: 'asset',     normalBalance: 'debit',  level: 3, displayOrder: 114, parentCode: '1100', subtype: 'vat_input', isSystem: true },
  { code: '2000', name: 'Liabilities',              type: 'liability', normalBalance: 'credit', level: 1, displayOrder: 200, isSystem: true },
  { code: '2100', name: 'Current Liabilities',      type: 'liability', normalBalance: 'credit', level: 2, displayOrder: 210, parentCode: '2000', isSystem: true },
  { code: '2110', name: 'Accounts Payable',         type: 'liability', normalBalance: 'credit', level: 3, displayOrder: 211, parentCode: '2100', subtype: 'payable', isSystem: true },
  { code: '2120', name: 'VAT Output',               type: 'liability', normalBalance: 'credit', level: 3, displayOrder: 212, parentCode: '2100', subtype: 'vat_output', isSystem: true },
  { code: '3000', name: 'Equity',                   type: 'equity',    normalBalance: 'credit', level: 1, displayOrder: 300, isSystem: true },
  { code: '3100', name: 'Share Capital',            type: 'equity',    normalBalance: 'credit', level: 2, displayOrder: 310, parentCode: '3000', subtype: 'equity', isSystem: true },
  { code: '3200', name: 'Retained Earnings',        type: 'equity',    normalBalance: 'credit', level: 2, displayOrder: 320, parentCode: '3000', subtype: 'retained_earnings', isSystem: true },
  { code: '4000', name: 'Revenue',                  type: 'revenue',   normalBalance: 'credit', level: 1, displayOrder: 400, isSystem: true },
  { code: '4100', name: 'Sales Revenue',            type: 'revenue',   normalBalance: 'credit', level: 2, displayOrder: 410, parentCode: '4000', subtype: 'default_revenue', isSystem: true },
  { code: '5000', name: 'Expenses',                 type: 'expense',   normalBalance: 'debit',  level: 1, displayOrder: 500, isSystem: true },
  { code: '5100', name: 'Cost of Sales',            type: 'expense',   normalBalance: 'debit',  level: 2, displayOrder: 510, parentCode: '5000', subtype: 'default_expense', isSystem: true },
  { code: '5500', name: 'Administrative',           type: 'expense',   normalBalance: 'debit',  level: 2, displayOrder: 560, parentCode: '5000', subtype: 'admin_expense', isSystem: true },
  { code: '5600', name: 'Bank Charges',             type: 'expense',   normalBalance: 'debit',  level: 2, displayOrder: 570, parentCode: '5000' },
] satisfies ReadonlyArray<{
  code: string; name: string; type: string; normalBalance: string;
  level: number; displayOrder: number; parentCode?: string; subtype?: string; isSystem?: boolean;
}>;

export async function seedCoa(sql: TaggedSql, companyId: string): Promise<Map<string, string>> {
  for (const acc of COA_TEMPLATE) {
    await sql`
      INSERT INTO gl_accounts (
        company_id, account_code, account_name, account_type, account_subtype,
        normal_balance, level, display_order, is_system_account
      ) VALUES (
        ${companyId}::uuid, ${acc.code}, ${acc.name}, ${acc.type},
        ${acc.subtype ?? null}, ${acc.normalBalance}, ${acc.level},
        ${acc.displayOrder}, ${acc.isSystem ?? false}
      )
      ON CONFLICT (company_id, account_code) DO NOTHING
    `;
  }
  for (const acc of COA_TEMPLATE) {
    if (!acc.parentCode) continue;
    await sql`
      UPDATE gl_accounts
      SET parent_account_id = (SELECT id FROM gl_accounts WHERE company_id = ${companyId}::uuid AND account_code = ${acc.parentCode})
      WHERE company_id = ${companyId}::uuid AND account_code = ${acc.code}
    `;
  }
  const rows = await sql`SELECT account_code, id FROM gl_accounts WHERE company_id = ${companyId}::uuid` as Array<{ account_code: string; id: string }>;
  console.log(`[coa] ${rows.length} accounts`);
  return new Map(rows.map((r) => [r.account_code, r.id]));
}

export async function seedBankAccount(sql: TaggedSql, companyId: string, coa: Map<string, string>): Promise<string> {
  const glId = coa.get('1110')!;
  const existing = await sql`SELECT id FROM bank_accounts WHERE company_id = ${companyId}::uuid AND account_number = 'QA-9000-0001' LIMIT 1` as Array<{ id: string }>;
  if (existing.length > 0) {
    console.log('[bank_account] exists');
    return existing[0]!.id;
  }
  const r = await sql`
    INSERT INTO bank_accounts (company_id, account_name, account_number, bank_name, account_type, gl_account_id, currency, is_active, opening_balance, current_balance)
    VALUES (${companyId}::uuid, 'QA Primary Cheque', 'QA-9000-0001', 'FNB', 'cheque', ${glId}::uuid, 'ZAR', true, 250000, 250000)
    RETURNING id
  ` as Array<{ id: string }>;
  console.log('[bank_account] created');
  return r[0]!.id;
}
