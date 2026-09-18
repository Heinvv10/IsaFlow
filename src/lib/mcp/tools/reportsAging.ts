/**
 * `aged_debtors` / `aged_creditors` v2 — WRAPS of the aging services.
 *
 * The audit's finding was exact: ten rows, no total, no rowsTotal, no
 * truncated, no envelope. Answering "what are we owed" meant summing ten rows
 * by hand, which is how R63,133,371.78 came to be a number somebody added up
 * rather than a number the tool reported.
 *
 * So the totals come first, and they are computed over EVERY entity, never over
 * the page. A paginated report whose totals describe only the page is the more
 * dangerous shape, because it looks complete.
 *
 * TWO THINGS BESIDE THE BUCKETS, because they change what the buckets mean:
 *
 *  - `unappliedReceipts` / `unappliedPayments` — cash on the control account
 *    attached to no document. Both sides have it: a receipt applied to no
 *    invoice reduces what customers owe, a supplier payment applied to no bill
 *    reduces what the company owes, and neither is in ANY of these buckets, so
 *    an aged total read on its own overstates the balance. It is NAMED, never
 *    netted: netting it would invent a figure no report owns.
 *  - `agedFromInvoiceDate` — invoices with no due date. Since #303 they are
 *    aged from their invoice date rather than dropped, so they ARE in the
 *    buckets and their age is derived. That belongs in front of the reader, and
 *    deliberately NOT in `excludedRows`: nothing is excluded any more, and
 *    saying otherwise would misdescribe the fix that stopped R1,058,000
 *    vanishing.
 *
 * The point-in-time caveat on `as_at` is the aging services' own — see
 * `services/shared/agingRewind.ts` — and is repeated in the descriptions
 * because a reader of the response never sees the service.
 */
import type { McpTool, McpToolResult, McpToolContext } from '../types';
import { fmtDate } from '@/lib/fmtDate';
import { getARAging, getARAgingDetail } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging, getAPAgingDetail } from '@/modules/accounting/services/ap/apAgingService';
import { getUnappliedReceipts } from '@/modules/accounting/services/ar/unappliedReceiptService';
import { getUnappliedPayments } from '@/modules/accounting/services/ap/unappliedPaymentService';
import { getLedgerPostedThrough } from '@/modules/accounting/services/reports/postedThroughService';
import {
  getUnappliedByEntity,
  getUnappliedCreditNotes,
  netAgingRows,
  type AgedSide,
} from '@/modules/accounting/services/shared/agedNetting';
import type { AgingBucket, AgingInvoice } from '@/modules/accounting/types/ap.types';
import {
  buildEnvelope,
  decodeCursor,
  encodeCursor,
  figureBasis,
  isDetailLevel,
  type DetailLevel,
} from '@/lib/mcp/contracts';
import { clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';
import { AS_AT_CAVEAT, NETTING_NOTE, TOTALS_NOTE, schemaFor } from './reportsAgingCopy';
import { derivedAge, round2, sumBuckets } from './reportsAgingTotals';

const CURSOR_PARTS = 1;

interface AgingSide {
  name: 'aged_debtors' | 'aged_creditors';
  entityLabel: string;
  aging: (companyId: string, asAt: string) => Promise<AgingBucket[]>;
  detail: (companyId: string, entityId: string, asAt: string) => Promise<{
    invoices: AgingInvoice[];
    entity: { id: string; name: string };
  }>;
  figure: string;
  /**
   * Cash on this side's control account attached to no document. Both sides
   * have it and both report it under their own key — `unappliedReceipts` for
   * AR, `unappliedPayments` for AP — so the shape is identical either way and
   * neither is ever netted off the buckets.
   */
  unapplied: {
    key: 'unappliedReceipts' | 'unappliedPayments';
    fetch: (companyId: string, asAt: string) => Promise<UnappliedSummary>;
  };
  /** Which side's credit notes and unapplied cash are netted per entity. */
  netting: AgedSide;
}

/** The two fields `runAging` needs from either unapplied-cash service. */
interface UnappliedSummary {
  rowsTotal: number;
  unattributed: readonly unknown[];
  totalUnapplied: number;
  totalUnattributed: number;
}

async function runAging(side: AgingSide, args: Record<string, unknown>, ctx: McpToolContext): Promise<McpToolResult> {
  // Casts validated BEFORE any query: a read tool runs with no savepoint, so a
  // 22007 or 22P02 after it aborts the whole request transaction.
  const bad = guardCastableArgs(args, { date: ['as_at'], uuid: ['entity_id'] });
  if (bad) return bad;

  const asAt = strArg(args, 'as_at') ?? fmtDate(new Date());
  const entityId = strArg(args, 'entity_id');
  const rawDetail = strArg(args, 'detail');
  const detail: DetailLevel = isDetailLevel(rawDetail) ? rawDetail : 'standard';

  const rawCursor = strArg(args, 'cursor');
  let after: string | null = null;
  if (rawCursor !== undefined) {
    const decoded = decodeCursor(rawCursor, CURSOR_PARTS);
    if (!decoded) return toolError('invalid cursor');
    after = decoded.parts[0]!;
  }

  const postedThrough = await getLedgerPostedThrough(ctx.companyId, asAt);

  if (entityId !== undefined) {
    // companyId from ctx ONLY.
    const one = await side.detail(ctx.companyId, entityId, asAt);
    const grossTotal = round2(one.invoices.reduce((s, i) => s + i.balance, 0));
    // The drill-down nets the SAME way the summary row does, or the two
    // disagree about one entity — which is worse than netting neither, because
    // the detail reads as the explanation of the row.
    const credit = round2((await getUnappliedByEntity(ctx.companyId, side.netting, asAt))
      .get(entityId)?.total ?? 0);
    const envelope = buildEnvelope({
      rows: detail === 'summary' ? [] : one.invoices,
      rowsTotal: one.invoices.length,
      detail,
      as_at: asAt,
      posted_through: postedThrough,
      // universeTotal is DELIBERATELY ABSENT. There is no wider candidate set
      // here: these rows are PRODUCED by the report, not selected out of a
      // pool, so any universe would have to be synthesized from the very
      // numbers the envelope checks against it — `rowsTotal + excludedRows`.
      // That is the anti-pattern CONTRACTS.md §1 names, and it cannot fail
      // whatever this code did. An absent completeness claim is honest; one
      // that cannot fail is worse than none, because it reads as verification.
      figureBasis: figureBasis(side.figure),
    });
    return ok({
      ...envelope,
      entity: one.entity,
      total: round2(grossTotal - credit),
      gross_total: grossTotal,
      unapplied: credit === 0 ? 0 : -credit,
      agedFromInvoiceDate: derivedAge(one.invoices),
    });
  }

  const grossBuckets = await side.aging(ctx.companyId, asAt);
  // Per-entity credit, merged into the rows: unapplied cash with a payment
  // document plus the face value live credit notes have not consumed. An entity
  // with credit and no open document gains a row here, so the net total below
  // cannot omit the entities that are in credit.
  const unappliedByEntity = await getUnappliedByEntity(ctx.companyId, side.netting, asAt);
  const buckets = netAgingRows(grossBuckets, unappliedByEntity);

  // Totals BEFORE the page is cut. This is the finding the tool exists to
  // report, and computing it from the page would make it follow the limit.
  const totals = sumBuckets(buckets);
  // GROSS stays, because the buckets are gross and a reader adding them up must
  // land on a number the report states. `total` is the NET — what the entity
  // actually owes once its credit is taken off — because that is the figure a
  // payment run or a collections call acts on.
  const grossTotal = round2(buckets.reduce((s, b) => s + b.total, 0));
  const total = round2(buckets.reduce((s, b) => s + b.net, 0));

  // A total order for paging. entityId is unique per company.
  const ordered = [...buckets].sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));
  const start = after === null ? 0 : ordered.findIndex((b) => b.entityId === after) + 1;
  const limit = clampLimit(args, 200, 500);
  const page = detail === 'summary' ? [] : ordered.slice(start, start + limit);
  const last = page[page.length - 1];
  const nextCursor =
    last !== undefined && start + limit < ordered.length
      ? encodeCursor({ parts: [last.entityId] })
      : null;

  const envelope = buildEnvelope({
    rows: page,
    rowsTotal: ordered.length,
    detail,
    as_at: asAt,
    posted_through: postedThrough,
    next_cursor: nextCursor,
    // universeTotal is DELIBERATELY ABSENT. There is no wider candidate set
    // here: these rows are PRODUCED by the report, not selected out of a
    // pool, so any universe would have to be synthesized from the very
    // numbers the envelope checks against it — `rowsTotal + excludedRows`.
    // That is the anti-pattern CONTRACTS.md §1 names, and it cannot fail
    // whatever this code did. An absent completeness claim is honest; one
    // that cannot fail is worse than none, because it reads as verification.
    figureBasis: figureBasis(side.figure),
  });

  const unapplied = await side.unapplied.fetch(ctx.companyId, asAt);
  const unappliedCredit = await getUnappliedCreditNotes(
    ctx.companyId, side.netting === 'ar' ? 'customer' : 'supplier', asAt,
  );

  return ok({
    ...envelope,
    // NET, and gross beside it. The rows carry both per entity.
    total,
    gross_total: grossTotal,
    buckets: totals,
    entityCount: ordered.length,
    // The COMPANY-WIDE figures, which are not the sum of the rows' `unapplied`:
    // cash whose counterparty cannot be resolved has no row to sit on, so it is
    // in here and in no `net`. The difference is exactly that unattributable
    // cash. list_unapplied_receipts / list_unapplied_payments have the rows.
    [side.unapplied.key]: {
      count: unapplied.rowsTotal + unapplied.unattributed.length,
      total: round2(unapplied.totalUnapplied + unapplied.totalUnattributed),
    },
    unappliedCreditNotes: {
      count: unappliedCredit.count,
      total: unappliedCredit.amount,
    },
  });
}

const AR_SIDE: AgingSide = {
  name: 'aged_debtors',
  entityLabel: 'customer',
  aging: (companyId, asAt) => getARAging(companyId, asAt),
  detail: async (companyId, entityId, asAt) => {
    const r = await getARAgingDetail(companyId, entityId, asAt);
    return { invoices: r.invoices, entity: r.client };
  },
  figure: 'ar.subledger.v1',
  netting: 'ar',
  unapplied: {
    key: 'unappliedReceipts',
    fetch: (companyId, asAt) => getUnappliedReceipts(companyId, { asAt, limit: 1 }),
  },
};

const AP_SIDE: AgingSide = {
  name: 'aged_creditors',
  entityLabel: 'supplier',
  aging: (companyId, asAt) => getAPAging(companyId, asAt),
  detail: async (companyId, entityId, asAt) => {
    const r = await getAPAgingDetail(companyId, entityId, asAt);
    return { invoices: r.invoices, entity: r.supplier };
  },
  figure: 'ap.subledger.v1',
  netting: 'ap',
  unapplied: {
    key: 'unappliedPayments',
    fetch: (companyId, asAt) => getUnappliedPayments(companyId, { asAt, limit: 1 }),
  },
};

export const agedDebtorsTool: McpTool = {
  name: 'aged_debtors',
  description:
    'Accounts-receivable aging buckets per customer as at a date (defaults to today), WITH the totals. '
    + TOTALS_NOTE
    + ' ' + NETTING_NOTE
    + ' unappliedReceipts and unappliedCreditNotes are the COMPANY-WIDE figures: receipts on the AR control account attached to no invoice, and credit notes with face value left. They are larger than the sum of the rows\' `unapplied` by exactly the cash whose customer cannot be resolved, which has no row to sit on. list_unapplied_receipts has the rows and reconcile_subledger explains the gap to the control account. '
    + AS_AT_CAVEAT,
  scope: 'read:reports',
  write: false,
  inputSchema: schemaFor('customer'),
  handler: (args, ctx) => runAging(AR_SIDE, args, ctx),
};

export const agedCreditorsTool: McpTool = {
  name: 'aged_creditors',
  description:
    'Accounts-payable aging buckets per supplier as at a date (defaults to today), WITH the totals. '
    + TOTALS_NOTE
    + ' ' + NETTING_NOTE
    + ' unappliedPayments and unappliedCreditNotes are the COMPANY-WIDE figures: payments on the AP control account attached to no bill, and supplier credit notes with face value left. They are larger than the sum of the rows\' `unapplied` by exactly the cash whose supplier cannot be resolved, which has no row to sit on. list_unapplied_payments has the rows and reconcile_subledger with subledger "ap" explains the gap to the control account. '
    + AS_AT_CAVEAT,
  scope: 'read:reports',
  write: false,
  inputSchema: schemaFor('supplier'),
  handler: (args, ctx) => runAging(AP_SIDE, args, ctx),
};
