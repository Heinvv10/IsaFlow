/**
 * Who created the unapplied receipts.
 *
 * THE BUCKET IS ACTIVELY FILLING, AND THIS IS WHAT PROVES IT.
 * `bankAllocationService#allocateTransaction` with `allocType='customer'` posts
 * DR Bank / CR Accounts Receivable, inserts a CONFIRMED `customer_payments`
 * row, and writes no `customer_payment_allocations` and no `amount_paid`. The
 * unapplied balance is therefore not a historical residue that stopped growing
 * — it is driven up by every allocation an agent makes, and a bulk run drives
 * it up hundreds of rows at a time.
 *
 * Re-derived against production on 2026-09-03: of R42,759,565.12 unapplied
 * system-wide, R39,486,371.68 (92.3%) carries an `mcp:` stamp, and every one of
 * those stamps is `bulk_allocate_bank_transactions`. Reporting the total
 * without that split sends a reader hunting for a historical cause that is not
 * there.
 *
 * READ-ONLY. This reports; it does not correct anything, and the write path is
 * deliberately out of scope for the assurance programme.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/** A cent. Matches the listing this accompanies. */
const EPS = 0.01;

export interface OriginBucket {
  receipts: number;
  unapplied: number;
}

export interface AgentToolBreakdown {
  postingAgent: string;
  receipts: number;
  unapplied: number;
}

export interface UnappliedReceiptOrigins {
  /** Stamped `mcp:` — an agent made it. This stamp PROVES an agent. */
  agent: OriginBucket;
  /** Stamped `system:` — IsaFlow's own jobs. */
  system: OriginBucket;
  /**
   * Everything else with a journal. Named for what is actually known: the row
   * is NOT STAMPED AS AN AGENT. It is not proof a person typed it —
   * `createJournalEntry` falls back to `defaultHumanMeta(userId)` whenever a
   * caller omits the meta, so agent postings are known to land here.
   */
  notStampedAsAgent: OriginBucket;
  /**
   * No journal linked at all. Its own bucket rather than folded into the one
   * above: "we cannot tell" and "a person did it" are different facts.
   */
  noJournal: OriginBucket;
  total: OriginBucket;
  /** Which agent tools, specifically. The answer to "what is filling this". */
  agentTools: AgentToolBreakdown[];
  /** Carried into the response so the asymmetry is never lost in transit. */
  caveat: string;
}

const CAVEAT =
  'An mcp: stamp proves an agent. Everything else with a journal is reported as "not stamped as '
  + 'an agent", NOT as human: createJournalEntry stamps human:<userId> whenever a caller omits '
  + 'the posting meta, so an unknown number of agent postings sit in that bucket. Receipts with '
  + 'no journal are counted separately because nothing is known about them at all.';

export async function getUnappliedReceiptOrigins(
  companyId: string,
  asAt: string,
): Promise<UnappliedReceiptOrigins> {
  // THE ON CLAUSE OF THE OUTER JOIN BELOW CARRIES ONLY JOIN KEYS, deliberately.
  // A predicate that must RESTRICT the result belongs in WHERE: inside an outer
  // join's ON it restricts nothing — the unmatched row survives carrying NULL
  // columns, and those NULLs flow straight into the arithmetic.
  // kpiChartsService did exactly that (is_active = true AND
  // account_subtype = 'bank' in a LEFT JOIN ON) and charted every transaction
  // regardless of account.
  //
  // A receipt with no journal is a legitimate outcome here rather than
  // something to filter away, and it is classified explicitly as `noJournal`
  // instead of being allowed through as a NULL posting_agent that reads like a
  // human.
  const rows = (await sql`
    SELECT je.posting_agent,
           COUNT(*)::INT AS receipts,
           COALESCE(SUM(cp.total_amount - COALESCE(alloc.allocated, 0)), 0) AS unapplied
    FROM customer_payments cp
    -- OUTER JOIN: ON carries ONLY join keys. See the note above the query.
    LEFT JOIN gl_journal_entries je
      ON je.id = cp.gl_journal_entry_id
     AND je.company_id = cp.company_id
    LEFT JOIN LATERAL (
      SELECT SUM(cpa.amount_allocated) AS allocated
      FROM customer_payment_allocations cpa
      LEFT JOIN control_cash_application_intents app ON app.company_id = cp.company_id AND app.id = cpa.application_intent_id
      LEFT JOIN control_cash_application_reversal_intents inverse ON inverse.company_id = cp.company_id AND inverse.id = cpa.reversal_intent_id
      WHERE cpa.payment_id = cp.id
        AND COALESCE(app.accounting_date, cp.payment_date) <= ${asAt}::DATE
        AND (inverse.reversal_date IS NULL OR inverse.reversal_date > ${asAt}::DATE)
    ) alloc ON TRUE
    WHERE cp.company_id = ${companyId}::UUID
      AND cp.status <> 'cancelled'
      AND cp.payment_date <= ${asAt}::DATE
      AND (cp.total_amount - COALESCE(alloc.allocated, 0)) > ${EPS}
    GROUP BY je.posting_agent
    ORDER BY unapplied DESC
  `) as DbRow[];

  const agent = empty();
  const system = empty();
  const notStampedAsAgent = empty();
  const noJournal = empty();
  const agentTools: AgentToolBreakdown[] = [];

  for (const row of rows) {
    const postingAgent = row.posting_agent === null || row.posting_agent === undefined
      ? null
      : String(row.posting_agent);
    const receipts = Number(row.receipts ?? 0);
    const unapplied = round2(Number(row.unapplied ?? 0));

    if (postingAgent === null) {
      add(noJournal, receipts, unapplied);
    } else if (postingAgent.startsWith('mcp:')) {
      add(agent, receipts, unapplied);
      agentTools.push({ postingAgent, receipts, unapplied });
    } else if (postingAgent.startsWith('system:')) {
      add(system, receipts, unapplied);
    } else {
      add(notStampedAsAgent, receipts, unapplied);
    }
  }

  return {
    agent,
    system,
    notStampedAsAgent,
    noJournal,
    total: {
      receipts: agent.receipts + system.receipts + notStampedAsAgent.receipts + noJournal.receipts,
      unapplied: round2(
        agent.unapplied + system.unapplied + notStampedAsAgent.unapplied + noJournal.unapplied,
      ),
    },
    agentTools,
    caveat: CAVEAT,
  };
}

function empty(): OriginBucket {
  return { receipts: 0, unapplied: 0 };
}

function add(bucket: OriginBucket, receipts: number, unapplied: number): void {
  bucket.receipts += receipts;
  bucket.unapplied = round2(bucket.unapplied + unapplied);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
