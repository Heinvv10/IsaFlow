/**
 * The eliminations of the MIRRORED intercompany documents (P2), derived at read time and never stored.
 *
 * `intercompany_mirror_eliminations(group, start, end)` returns the mirrored group rows the two ledgers support AS AT the period end (reversal
 * chains counting only links dated on or before it, the receiver's financial-year cut-off, both journals' figures by value). Nothing is written,
 * so no hook, lock or repair stands between a ledger and a figure, and a reversal booked in a later period cannot change an earlier one.
 * A credit note's row is negative: its entry is the invoice's with the sides swapped, in positive amounts.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

export const MIRRORED_LABEL = 'Automatic: mirrored intercompany documents';

export interface MirroredElimination {
  transactionId: string;
  transactionDate: string;
  description: string;
  amount: number;
  lines: Array<{
    groupAccountId: string; groupAccountCode: string; groupAccountName: string; groupAccountType: string;
    debit: number; credit: number; description: string;
  }>;
}

async function groupAccountFor(groupId: string, companyId: string, accountType: string): Promise<Row | null> {
  const rows = (await sql`
    SELECT ga.id, ga.account_code, ga.account_name, ga.account_type
      FROM group_coa_mappings gcm
      JOIN gl_accounts a ON a.id = gcm.company_account_id AND a.company_id = ${companyId}::UUID
      JOIN group_accounts ga ON ga.id = gcm.group_account_id
     WHERE gcm.group_id = ${groupId}::UUID AND gcm.company_id = ${companyId}::UUID AND a.account_type = ${accountType}
     ORDER BY ga.account_code, ga.id LIMIT 1
  `) as Row[];
  return rows[0] ?? null;
}

const dateText = (d: unknown): string => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10));

/** The mirrored documents' eliminations for [periodStart, periodEnd], as at periodEnd. A row whose companies lack a revenue / expense mapping is logged and left out (as the manual generator does). */
export async function getMirroredEliminations(groupId: string, periodStart: string, periodEnd: string): Promise<MirroredElimination[]> {
  const rows = (await sql`
    SELECT transaction_id, source_company_id, target_company_id, amount, transaction_date, description
      FROM public.intercompany_mirror_eliminations(${groupId}::UUID, ${periodStart}::DATE, ${periodEnd}::DATE)
     ORDER BY transaction_date, transaction_id
  `) as Row[];
  const out: MirroredElimination[] = [];
  for (const r of rows) {
    const rev = await groupAccountFor(groupId, String(r.source_company_id), 'revenue');
    const exp = await groupAccountFor(groupId, String(r.target_company_id), 'expense');
    if (!rev || !exp) {
      log.warn('Mirrored elimination left out: no group account mapped for the revenue or expense side', { groupId, transactionId: String(r.transaction_id) }, 'accounting');
      continue;
    }
    const signed = Number(r.amount);
    const amount = Math.abs(signed);
    const swapped = signed < 0;
    const line = (ga: Row, debit: boolean, what: string) => ({
      groupAccountId: String(ga.id), groupAccountCode: String(ga.account_code), groupAccountName: String(ga.account_name),
      groupAccountType: String(ga.account_type ?? ''), debit: debit ? amount : 0, credit: debit ? 0 : amount, description: what,
    });
    out.push({
      transactionId: String(r.transaction_id), transactionDate: dateText(r.transaction_date), amount: signed,
      description: `${MIRRORED_LABEL} - ${String(r.description ?? '')}`.trim(),
      lines: [line(rev, !swapped, 'Eliminate intercompany sale revenue'), line(exp, swapped, 'Eliminate intercompany sale expense')],
    });
  }
  return out;
}
