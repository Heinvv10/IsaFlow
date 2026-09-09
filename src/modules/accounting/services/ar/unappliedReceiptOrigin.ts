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

import {loadUnappliedCashHistory,type CashHistoryCoverage} from '../shared/unappliedCashHistory';


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
   * Retained compatibility bucket. Missing original posted journals are now
   * excluded from historical totals and disclosed by historyCoverage.
   */
  noJournal: OriginBucket;
  total: OriginBucket;
  /** Which agent tools, specifically. The answer to "what is filling this". */
  agentTools: AgentToolBreakdown[];
  /** Carried into the response so the asymmetry is never lost in transit. */
  caveat: string;
  historyCoverage: CashHistoryCoverage;
  postedThrough: string;
}

const CAVEAT =
  'An mcp: stamp proves an agent. Everything else with a journal is reported as "not stamped as '
  + 'an agent", NOT as human: createJournalEntry stamps human:<userId> whenever a caller omits '
  + 'the posting meta, so an unknown number of agent postings sit in that bucket. Receipts with '
  + 'no original posted journal are excluded from asserted historical totals and disclosed by historyCoverage.';

export async function getUnappliedReceiptOrigins(
  companyId: string,
  asAt: string,
): Promise<UnappliedReceiptOrigins> {
  const history=await loadUnappliedCashHistory(companyId,'customer',asAt);
  const rows=history.rows.map(row=>({posting_agent:row.posting_agent,receipts:1,unapplied:row.unapplied_amount}));

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
      add(notStampedAsAgent, receipts, unapplied);
    } else if (postingAgent.startsWith('mcp:')) {
      add(agent, receipts, unapplied);
      const existing=agentTools.find(item=>item.postingAgent===postingAgent);
      if(existing){existing.receipts+=receipts;existing.unapplied=round2(existing.unapplied+unapplied);}
      else agentTools.push({ postingAgent, receipts, unapplied });
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
    historyCoverage: history.historyCoverage,
    postedThrough: history.postedThrough,
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
