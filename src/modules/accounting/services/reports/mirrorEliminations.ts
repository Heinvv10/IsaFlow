/**
 * The eliminations of the MIRRORED intercompany documents (P2), derived at read time and never stored.
 *
 * `intercompany_mirror_eliminations(group, start, end)` returns the dated EVENTS of each mirrored row whose two companies are current members of
 * the group: +E (kind 'eliminate') on the date the two ledgers start supporting the pair, and the counter-elimination -E (kind 'reverse') on
 * the date they stop (a value-negating reversal on either side), each judged with only the links dated on or before it; standing again is a
 * new +E. A period is the sum of the events dated in it, so at any moment any range is the sum of its months line by line; a later booking or
 * reversal does not change an earlier period. THE LIMIT: the reversal chains are dated, the reference data the judgement reads is NOT: the receiver's
 * fiscal periods (the financial-year cut-off), the connection side's and the document's supplier (an unbound row), which other rows hold a journal, the
 * group's members and its account mappings are read as they are today, so editing one can change a PAST period's figure; so does re-pointing a
 * receiver document's journal link (1018 refuses that swap to non-superusers). Within a period a +E and a -E on one receiver journal cancel. The lines are the journals' OWN accounts (the sender's
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

/**
 * A mirrored row the group figures keep un-eliminated, reported with the derivation (the mirror is automatic: nobody would see it otherwise):
 *  - 'unmapped': its elimination event could NOT be applied, one of its accounts has no group account mapped (map the accounts);
 *  - 'unresolved': it has NO elimination from any path (a variance: the receiver's journal does not carry the sender's figures, or the receiver
 *    cancelled its document; the manual generator and match refuse a mirrored row), so only a manual elimination with a reason can eliminate
 *    the sale. `detail` says why (intercompany_mirror_unresolved); `keyDate` is the row's date.
 */
export interface DroppedMirroredElimination { transactionId: string; keyDate: string; description: string; amount: number; kind: 'unmapped' | 'unresolved'; detail: string }

/** Money to cents, as the consolidated reports round (the derived lines are summed by the reports, so each is rounded here once). */
const cents = (n: number): number => Math.round(n * 100) / 100;

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

/**
 * The mirrored documents' elimination events dated in [periodStart, periodEnd]. An event with an account that has no group account is left out
 * whole (half an elimination would unbalance the group) and reported: logged at ERROR and, when `dropped` is given, pushed there for the page.
 */
export async function getMirroredEliminations(
  groupId: string, periodStart: string, periodEnd: string, dropped?: DroppedMirroredElimination[],
): Promise<MirroredElimination[]> {
  const derived = await deriveEliminations(groupId, periodStart, periodEnd, dropped);
  if (dropped) dropped.push(...await unresolvedMirrored(groupId, periodStart, periodEnd));
  return derived;
}

/** The mirrored rows dated in the period that NO path eliminates (intercompany_mirror_unresolved), as the page and the reports list them. */
async function unresolvedMirrored(groupId: string, periodStart: string, periodEnd: string): Promise<DroppedMirroredElimination[]> {
  const rows = ((await sql`
    SELECT transaction_id, transaction_date, description, amount, reason
      FROM public.intercompany_mirror_unresolved(${groupId}::UUID, ${periodStart}::DATE, ${periodEnd}::DATE)
  `) ?? []) as Row[];
  return rows.map((r) => ({ transactionId: String(r.transaction_id), keyDate: dateText(r.transaction_date), description: String(r.description ?? '').trim(),
    amount: cents(Number(r.amount)), kind: 'unresolved', detail: String(r.reason ?? '') }));
}

async function deriveEliminations(
  groupId: string, periodStart: string, periodEnd: string, dropped?: DroppedMirroredElimination[],
): Promise<MirroredElimination[]> {
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
            amount: cents(kind === 'reverse' ? -Number(r.amount) : Number(r.amount)),
            description: kind === 'reverse'
              ? `${MIRRORED_REVERSAL_LABEL} - ${String(r.description ?? '')} (no longer standing from ${keyDate})`.trim()
              : `${MIRRORED_LABEL} - ${String(r.description ?? '')}`.trim() };
      byRow.set(key, e);
    }
    const revenue = String(r.side) === 'revenue';
    const ga = mappings.get(`${String(revenue ? r.source_company_id : r.target_company_id)}:${String(r.gl_account_id)}`);
    if (!ga) { e.skip = true; continue; }
    const net = cents(Number(r.net));
    // revenue: debited by what the sender booked as revenue; expense: credited by what the receiver booked as expense (a credit note, or a
    // counter-elimination, whose net the database has already negated: swapped)
    const debit = revenue ? Math.max(net, 0) : Math.max(-net, 0);
    const credit = revenue ? Math.max(-net, 0) : Math.max(net, 0);
    e.lines.push({ groupAccountId: ga.id, groupAccountCode: ga.code, groupAccountName: ga.name, groupAccountType: ga.type, groupAccountSubtype: ga.subtype, debit, credit,
                   description: `${kind === 'reverse' ? 'Reverse the elimination of' : 'Eliminate'} intercompany ${revenue ? 'revenue' : 'expense'}` });
  }
  const out: MirroredElimination[] = [];
  for (const { skip, ...e } of byRow.values()) {
    if (skip) {
      log.error('Mirrored elimination left out: an account has no group account mapped', { groupId, transactionId: e.transactionId }, 'accounting');
      dropped?.push({ transactionId: e.transactionId, keyDate: e.keyDate, description: e.description, amount: e.amount, kind: 'unmapped', detail: '' });
    } else out.push(e);
  }
  return out;
}

/**
 * Whether a derived line can land on a BALANCE-SHEET line: only when some company revenue / expense account (the accounts the derived lines
 * are read from) is mapped to a balance-sheet group account, or to a group account a company balance-sheet account is also mapped to.
 * The cumulative (inception) windows of the trial balance and the balance sheet use balance-sheet accounts only, so when this is false
 * they need not derive at all: the same answer without walking the group's whole mirrored history.
 */
export async function mirroredLinesReachBalanceSheet(groupId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM group_coa_mappings gcm
      JOIN group_accounts ga ON ga.id = gcm.group_account_id
      JOIN gl_accounts a ON a.id = gcm.company_account_id AND a.company_id = gcm.company_id
     WHERE gcm.group_id = ${groupId}::UUID AND a.account_type IN ('revenue', 'expense')
       AND (ga.account_type IN ('asset', 'liability', 'equity')
            OR EXISTS (SELECT 1 FROM group_coa_mappings g2 JOIN gl_accounts b ON b.id = g2.company_account_id AND b.company_id = g2.company_id
                        WHERE g2.group_id = gcm.group_id AND g2.group_account_id = gcm.group_account_id AND b.account_type IN ('asset', 'liability', 'equity')))
     LIMIT 1
  `) as Row[];
  return rows.length > 0;
}
