/**
 * The eliminations of the MIRRORED intercompany documents (P2), derived at read time and never stored.
 *
 * `intercompany_mirror_eliminations(group, start, end)` returns the dated EVENTS of each mirrored row whose two companies are current members of
 * the group: +E (kind 'eliminate') on the date the two ledgers start supporting the pair, and the counter-elimination -E (kind 'reverse') on
 * the date they stop (a value-negating reversal on either side), each judged with only the links dated on or before it; standing again is a
 * new +E. A period is the sum of the events dated in it, so any range is the sum of its months line by line and a later booking never changes
 * an earlier period. Within a period a +E and a -E on one receiver journal cancel. The lines are the journals' OWN accounts (the sender's
 * revenue, the receiver's expense), each mapped to its group account. A credit note's row is negative: its entry is the invoice's with the
 * sides swapped, in positive amounts; a counter-elimination swaps them again.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

export const MIRRORED_LABEL = 'Automatic: mirrored intercompany documents';
/** The label of a counter-elimination: the pair stopped standing in the period (a reversal on either side). */
export const MIRRORED_REVERSAL_LABEL = 'Automatic counter-elimination: mirrored intercompany documents reversed';

export interface MirroredLine {
  groupAccountId: string; groupAccountCode: string; groupAccountName: string; groupAccountType: string; groupAccountSubtype: string;
  debit: number; credit: number; description: string;
}

export interface MirroredElimination {
  transactionId: string;
  /** The receiver's journal the pair stood on (one row can stand on a second journal after a reverse-and-repost). */
  receiverJournalId: string;
  /** 'eliminate' (+E: the pair started standing) or 'reverse' (-E: it stopped standing; the lines are the elimination's, swapped). */
  kind: 'eliminate' | 'reverse';
  /** The date of the event: the day the pair started (the later of the two journals' dates) or stopped standing. */
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

/** The mirrored documents' elimination events dated in [periodStart, periodEnd]. A row with an account that has no group account is logged and left out whole (as the manual generator does). */
export async function getMirroredEliminations(groupId: string, periodStart: string, periodEnd: string): Promise<MirroredElimination[]> {
  const rows = (await sql`
    SELECT transaction_id, source_company_id, target_company_id, amount, key_date, description, side, gl_account_id, net, receiver_journal_id, kind
      FROM public.intercompany_mirror_eliminations(${groupId}::UUID, ${periodStart}::DATE, ${periodEnd}::DATE)
     ORDER BY key_date, transaction_id, receiver_journal_id, side DESC, gl_account_id
  `) as Row[];
  if (rows.length === 0) return [];
  const mappings = await loadMappings(groupId);
  const byRow = new Map<string, MirroredElimination & { skip: boolean }>();
  for (const r of rows) {
    const id = String(r.transaction_id);
    const kind = String(r.kind) === 'reverse' ? 'reverse' : 'eliminate';
    const key = `${id}:${String(r.receiver_journal_id)}:${kind}`;
    let e = byRow.get(key);
    if (!e) {
      const keyDate = dateText(r.key_date);
      e = { transactionId: id, receiverJournalId: String(r.receiver_journal_id), kind, keyDate, skip: false, lines: [],
            amount: kind === 'reverse' ? -Number(r.amount) : Number(r.amount),
            description: kind === 'reverse'
              ? `${MIRRORED_REVERSAL_LABEL} - ${String(r.description ?? '')} (no longer standing from ${keyDate})`.trim()
              : `${MIRRORED_LABEL} - ${String(r.description ?? '')}`.trim() };
      byRow.set(key, e);
    }
    const revenue = String(r.side) === 'revenue';
    const ga = mappings.get(`${String(revenue ? r.source_company_id : r.target_company_id)}:${String(r.gl_account_id)}`);
    if (!ga) { e.skip = true; continue; }
    const net = Number(r.net);
    // revenue: debited by what the sender booked as revenue; expense: credited by what the receiver booked as expense (a credit note, or a
    // counter-elimination, whose net the database has already negated: swapped)
    const debit = revenue ? Math.max(net, 0) : Math.max(-net, 0);
    const credit = revenue ? Math.max(-net, 0) : Math.max(net, 0);
    e.lines.push({ groupAccountId: ga.id, groupAccountCode: ga.code, groupAccountName: ga.name, groupAccountType: ga.type, groupAccountSubtype: ga.subtype, debit, credit,
                   description: `${kind === 'reverse' ? 'Reverse the elimination of' : 'Eliminate'} intercompany ${revenue ? 'revenue' : 'expense'}` });
  }
  const out: MirroredElimination[] = [];
  for (const { skip, ...e } of byRow.values()) {
    if (skip) log.warn('Mirrored elimination left out: an account has no group account mapped', { groupId, transactionId: e.transactionId }, 'accounting');
    else out.push(e);
  }
  return out;
}
