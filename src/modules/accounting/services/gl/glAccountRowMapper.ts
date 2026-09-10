import type {GLAccount,GLAccountType} from '../../types/gl.types';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapRow(row: any): GLAccount {
  return {
    id: String(row.id),
    accountCode: String(row.account_code),
    accountName: String(row.account_name),
    accountType: String(row.account_type) as GLAccountType,
    accountSubtype: row.account_subtype ? String(row.account_subtype) : undefined,
    parentAccountId: row.parent_account_id ? String(row.parent_account_id) : undefined,
    isActive: Boolean(row.is_active),
    isSystemAccount: Boolean(row.is_system_account),
    description: row.description ? String(row.description) : undefined,
    normalBalance: String(row.normal_balance) as 'debit' | 'credit',
    level: Number(row.level),
    displayOrder: Number(row.display_order),
    bankAccountNumber: row.bank_account_number ? String(row.bank_account_number) : undefined,
    defaultVatCode: (row.default_vat_code || 'none') as GLAccount['defaultVatCode'],
    vatInputDenied: Boolean(row.vat_input_denied),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    hasTransactions: row.has_transactions !== undefined ? Boolean(row.has_transactions) : undefined,
  };
}
