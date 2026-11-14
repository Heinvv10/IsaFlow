/**
 * What ONE document's own journal chain did to the control accounts, as a
 * LATERAL subquery for the party ledger check.
 *
 * The chain is the linked entry plus every entry that reverses it, then the
 * reversal of that, and so on (`reversal_of_id`; the unique index on
 * (company_id, reversal_of_id) keeps it linear). Reversing is additive here --
 * the original stays `posted` and a posted contra is added -- so the chain's
 * posted lines, dated on or before the reporting date, net to what the document
 * still has on the ledger: the full value while standing, zero once cancelled.
 * That is the same reading `shared/journalInForceAsAt` and the soft-delete
 * presence rule take of a reversal chain.
 *
 * Signed in the statement's orientation (receivable: debit less credit; payable:
 * credit less debit), so a clean document's GL net equals its statement effect.
 *
 * The depth bound stops a forged loop; it is a guard against bad data, not a
 * limit a real chain reaches.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { JournalFacts } from './partyLedgerTypes';

/** The closed set of document aliases whose journal link this may correlate on. */
export type JournalLinkColumn =
  | 'ci.gl_journal_entry_id'
  | 'si.gl_journal_entry_id'
  | 'd.gl_journal_entry_id'
  /** A payment's EFFECTIVE journal: its own, else its batch's (see readPartyPayments). */
  | 'pj.jid';

const MAX_CHAIN_DEPTH = 25;

interface LateralInput {
  companyId: string;
  asAtDate: string;
  controlIds: string[];
  side: 'ar' | 'ap';
  link: JournalLinkColumn;
}

/** Splice as `LEFT JOIN LATERAL (${journalChainLateral(...)}) jr ON TRUE`. */
export function journalChainLateral({ companyId, asAtDate, controlIds, side, link }: LateralInput) {
  const orient = side === 'ar' ? 'jl.debit - jl.credit' : 'jl.credit - jl.debit';
  return sql`
    WITH RECURSIVE chain(id, depth) AS (
      SELECT je.id, 1
      FROM gl_journal_entries je
      WHERE je.id = ${sql.unsafe(link)} AND je.company_id = ${companyId}::UUID
      UNION ALL
      SELECT r.id, c.depth + 1
      FROM gl_journal_entries r
      JOIN chain c ON r.reversal_of_id = c.id
      WHERE r.company_id = ${companyId}::UUID AND c.depth < ${MAX_CHAIN_DEPTH}
    ),
    standing AS (
      SELECT c.id, c.depth
      FROM chain c
      JOIN gl_journal_entries je ON je.id = c.id AND je.company_id = ${companyId}::UUID
                                AND je.status = 'posted'
                                AND je.entry_date <= ${asAtDate}::DATE
    ),
    lines AS (
      SELECT jl.gl_account_id AS acc, (${sql.unsafe(orient)}) AS v
      FROM standing s
      JOIN gl_journal_lines jl ON jl.journal_entry_id = s.id AND jl.company_id = ${companyId}::UUID
    )
    SELECT
      (SELECT h.status FROM gl_journal_entries h
        WHERE h.id = ${sql.unsafe(link)} AND h.company_id = ${companyId}::UUID) AS head_status,
      (SELECT h.entry_date FROM gl_journal_entries h
        WHERE h.id = ${sql.unsafe(link)} AND h.company_id = ${companyId}::UUID) AS head_date,
      COALESCE((SELECT SUM(l.v) FROM lines l WHERE l.acc = ANY(${controlIds}::uuid[])), 0) AS ctrl_net,
      (SELECT COUNT(*) FROM lines l WHERE l.acc = ANY(${controlIds}::uuid[])) AS ctrl_lines,
      (SELECT COUNT(*) FROM standing s WHERE s.depth > 1) AS reversals,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('code', ga.account_code, 'name', ga.account_name, 'net', x.net)
                         ORDER BY ga.account_code)
        FROM (
          SELECT l.acc, SUM(l.v) AS net FROM lines l
          WHERE NOT (l.acc = ANY(${controlIds}::uuid[]))
          GROUP BY l.acc HAVING SUM(l.v) <> 0
        ) x
        JOIN gl_accounts ga ON ga.id = x.acc AND ga.company_id = ${companyId}::UUID
      ), '[]'::jsonb) AS non_control`;
}

/** The SELECT-list fragment that reads the lateral's columns, aliased `jr`. */
export const JOURNAL_COLUMNS =
  'jr.head_status, jr.head_date, jr.ctrl_net, jr.ctrl_lines, jr.reversals, jr.non_control';

interface NonControlJson {
  code: string;
  name: string | null;
  net: number | string;
}

export function parseJournalFacts(r: DbRow, journalId: unknown): JournalFacts {
  const raw = Array.isArray(r.non_control) ? (r.non_control as NonControlJson[]) : [];
  return {
    journalId: journalId == null ? null : String(journalId),
    status: r.head_status == null ? null : String(r.head_status),
    entryDate: r.head_date == null ? null : fmtDate(r.head_date as string | Date),
    controlNet: Number(r.ctrl_net ?? 0),
    controlLines: Number(r.ctrl_lines ?? 0),
    reversalsInForce: Number(r.reversals ?? 0),
    nonControl: raw.map((a) => ({ code: String(a.code), name: String(a.name ?? ''), net: Number(a.net) })),
  };
}
