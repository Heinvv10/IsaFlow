/**
 * The eliminations of the MIRRORED intercompany documents (P2), derived at read time and never stored.
 *
 * `intercompany_mirror_eliminations(group, start, end)` returns the elimination LINES the two ledgers support AS AT the period end (reversal
 * chains counting only links dated on or before it, the receiver's financial-year cut-off, both journals' figures by value), for the rows whose
 * period key (the later of the sender's document date and the receiver's journal date) falls in the period. The lines are the journals' OWN
 * accounts: the sender's revenue accounts and the receiver's expense accounts, each mapped to its group account. Nothing is written, so no hook,
 * lock or repair stands between a ledger and a figure, and a reversal booked in a later period cannot change an earlier one. A credit note's
 * row is negative: its entry is the invoice's with the sides swapped, in positive amounts.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

export const MIRRORED_LABEL = 'Automatic: mirrored intercompany documents';

export interface MirroredLine {
  groupAccountId: string; groupAccountCode: string; groupAccountName: string; groupAccountType: string; groupAccountSubtype: string;
  debit: number; credit: number; description: string;
}

export interface MirroredElimination {
  transactionId: string;
  /** The period the elimination belongs to: the later of the sender's document date and the receiver's journal date. */
  keyDate: string;
  description: string;
  amount: number;
  lines: MirroredLine[];
}

interface GroupAccount { id: string; code: string; name: string; type: string; subtype: string }

const dateText = (d: unknown): string => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10));

/** Every company account mapped to a group account of this group, in one query: `company:account` -> its group account. */
async function loadMappings(groupId: string): Promise<Map<string, GroupAccount>> {
  const rows = (await sql`
    SELECT gcm.company_id, gcm.company_account_id, ga.id, ga.account_code, ga.account_name, ga.account_type, ga.account_subtype
      FROM group_coa_mappings gcm JOIN group_accounts ga ON ga.id = gcm.group_account_id
     WHERE gcm.group_id = ${groupId}::UUID
  `) as Row[];
  return new Map(rows.map((r) => [`${String(r.company_id)}:${String(r.company_account_id)}`,
    { id: String(r.id), code: String(r.account_code), name: String(r.account_name), type: String(r.account_type ?? ''), subtype: String(r.account_subtype ?? '') }]));
}

/** The mirrored documents' eliminations whose period key is in [periodStart, periodEnd], as at periodEnd. A row with an account that has no group account is logged and left out whole (as the manual generator does). */
export async function getMirroredEliminations(groupId: string, periodStart: string, periodEnd: string): Promise<MirroredElimination[]> {
  const rows = (await sql`
    SELECT transaction_id, source_company_id, target_company_id, amount, key_date, description, side, gl_account_id, net
      FROM public.intercompany_mirror_eliminations(${groupId}::UUID, ${periodStart}::DATE, ${periodEnd}::DATE)
     ORDER BY key_date, transaction_id, side DESC, gl_account_id
  `) as Row[];
  if (rows.length === 0) return [];
  const mappings = await loadMappings(groupId);
  const byRow = new Map<string, MirroredElimination & { skip: boolean }>();
  for (const r of rows) {
    const id = String(r.transaction_id);
    let e = byRow.get(id);
    if (!e) {
      e = { transactionId: id, keyDate: dateText(r.key_date), amount: Number(r.amount), skip: false, lines: [],
            description: `${MIRRORED_LABEL} - ${String(r.description ?? '')}`.trim() };
      byRow.set(id, e);
    }
    const revenue = String(r.side) === 'revenue';
    const ga = mappings.get(`${String(revenue ? r.source_company_id : r.target_company_id)}:${String(r.gl_account_id)}`);
    if (!ga) { e.skip = true; continue; }
    const net = Number(r.net);
    // revenue: debited by what the sender booked as revenue; expense: credited by what the receiver booked as expense (a credit note: swapped)
    const debit = revenue ? Math.max(net, 0) : Math.max(-net, 0);
    const credit = revenue ? Math.max(-net, 0) : Math.max(net, 0);
    e.lines.push({ groupAccountId: ga.id, groupAccountCode: ga.code, groupAccountName: ga.name, groupAccountType: ga.type, groupAccountSubtype: ga.subtype, debit, credit,
                   description: `Eliminate intercompany ${revenue ? 'revenue' : 'expense'}` });
  }
  const out: MirroredElimination[] = [];
  for (const { skip, ...e } of byRow.values()) {
    if (skip) log.warn('Mirrored elimination left out: an account has no group account mapped', { groupId, transactionId: e.transactionId }, 'accounting');
    else out.push(e);
  }
  return out;
}
