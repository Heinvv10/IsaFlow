import { assertControlTx } from '../controls/context';
import type { ControlTx, OperationRef } from '../controls/contracts';
import { typeFitsSubtype, type SystemAccountKey } from '../gl/systemAccountKeys';

type Account = Record<string, unknown> & { id: string };
export function selectApSystemAccount(rows: readonly Account[], role: SystemAccountKey): Account {
  const candidates = rows.filter(row => row.account_subtype === role && row.is_active === true && row.is_system_account === true);
  if (candidates.length > 1) throw new Error(`Ambiguous AP system account: ${role}`);
  const account = candidates[0];
  if (!account || !typeFitsSubtype(String(account.account_type), role)) throw new Error(`Missing or invalid AP system account: ${role}`);
  return account;
}
/** Uses the existing active/system/subtype contract, with no cache or ambiguous winner. */
export async function resolveApControlAccounts(ctx: ControlTx, ref: OperationRef) {
  assertControlTx(ctx);
  const company = ctx.principal.companyId;
  const [ledger] = await ctx.sql`SELECT id,default_currency FROM companies WHERE id=${company}::uuid FOR SHARE` as Array<{ id: string; default_currency: string }>;
  if (!ledger || !/^[A-Z]{3}$/.test(ledger.default_currency)) throw new Error('Ledger currency unavailable');
  const invoice = ref.entityType === 'supplier_invoice';
  const reverse = ['supplier_invoice.cancel', 'supplier_payment.void'].includes(ref.operation);
  const [parent] = invoice ? await ctx.sql`
    SELECT gl_journal_entry_id,NULL::uuid AS bank_account_id FROM supplier_invoices
    WHERE company_id=${company}::uuid AND id=${ref.entityId}::uuid
  ` : await ctx.sql`
    SELECT gl_journal_entry_id,bank_account_id FROM supplier_payments
    WHERE company_id=${company}::uuid AND id=${ref.entityId}::uuid
  `;
  const source = parent as { gl_journal_entry_id: string | null; bank_account_id: string | null } | undefined;
  if (!source) throw new Error('AP account parent not found');
  const roles: SystemAccountKey[] = reverse ? [] : invoice ? ['payable', 'vat_input', 'default_expense']
    : source.bank_account_id ? ['payable'] : ['payable', 'bank'];
  const systemAccounts = await ctx.sql`
    SELECT id,account_code,account_name,account_type,account_subtype,is_active,is_system_account
    FROM gl_accounts WHERE company_id=${company}::uuid AND account_subtype=ANY(${roles}::text[])
      AND is_system_account=true AND is_active=true ORDER BY id FOR SHARE
  ` as Account[];
  const chosen = Object.fromEntries(roles.map(role => [role, selectApSystemAccount(systemAccounts, role)]));
  const linked = invoice ? await ctx.sql`
    SELECT DISTINCT sii.gl_account_id AS id FROM supplier_invoice_items sii
    JOIN supplier_invoices si ON si.id=sii.supplier_invoice_id
    WHERE si.company_id=${company}::uuid AND si.id=${ref.entityId}::uuid AND sii.gl_account_id IS NOT NULL
  ` as Array<{ id: string }> : source.bank_account_id ? [{ id: source.bank_account_id }] : [];
  let journal: Record<string, unknown> | null = null;
  if (source.gl_journal_entry_id) {
    const [header] = await ctx.sql`SELECT * FROM gl_journal_entries WHERE company_id=${company}::uuid AND id=${source.gl_journal_entry_id}::uuid FOR SHARE`;
    if (!header) throw new Error('Owned AP journal not found');
    const lines = await ctx.sql`SELECT * FROM gl_journal_lines WHERE company_id=${company}::uuid
      AND journal_entry_id=${source.gl_journal_entry_id}::uuid ORDER BY id FOR SHARE` as Array<{ gl_account_id: string }>;
    journal = { header, lines }; linked.push(...lines.map(line => ({ id: line.gl_account_id })));
  }
  const ids = [...new Set(linked.map(row => row.id))].sort();
  const explicitAccounts = await ctx.sql`
    SELECT id,account_code,account_name,account_type,account_subtype,is_active,is_system_account
    FROM gl_accounts WHERE company_id=${company}::uuid AND id=ANY(${ids}::uuid[]) ORDER BY id FOR SHARE
  ` as Account[];
  if (explicitAccounts.length !== ids.length || explicitAccounts.some(account => account.is_active !== true)) throw new Error('AP account is missing, foreign or inactive');
  if (!invoice && source.bank_account_id) chosen.bank = explicitAccounts.find(account => account.id === source.bank_account_id)!;
  return { chosen, ledgerCurrency: ledger.default_currency, facts: { ledger, systemAccounts, explicitAccounts, journal } };
}
