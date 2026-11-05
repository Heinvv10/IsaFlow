/**
 * `due_by_date` — what falls due by a date, per customer and per supplier.
 *
 * A WRAP of the report service (services/reports/dueByDateService), which reads
 * the same open-document queries as the aging, so overdueNow + dueTodayToDate +
 * dueLater + noDueDate equals the aged total (`total`). Current balances only:
 * there is no as-at. Totals are over EVERY contact, never the page.
 */
import type { McpTool, McpToolResult, McpToolContext } from '../types';
import { endOfMonth, netPosition, type DueByDateContact, type DueByDateSide } from '@/modules/accounting/utils/dueByDate';
import {
  appToday,
  DueByDateInputError,
  getDueByDate,
} from '@/modules/accounting/services/reports/dueByDateService';
import { guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const SIDES = ['ar', 'ap'] as const;
type Side = (typeof SIDES)[number];

function shape(side: DueByDateSide, entityId: string | undefined) {
  const contacts = entityId === undefined
    ? side.contacts.map(({ invoices: _invoices, ...c }: DueByDateContact) => c)
    : side.contacts.filter((c) => c.contactId === entityId);
  return { totals: side.totals, contactCount: side.contacts.length, contacts };
}

async function handler(args: Record<string, unknown>, ctx: McpToolContext): Promise<McpToolResult> {
  const bad = guardCastableArgs(args, { date: ['by_date'], uuid: ['entity_id'] });
  if (bad) return bad;

  const sideArg = strArg(args, 'side');
  if (sideArg !== undefined && !(SIDES as readonly string[]).includes(sideArg)) {
    return toolError('side must be "ar" or "ap"');
  }
  const entityId = strArg(args, 'entity_id');
  if (entityId !== undefined && sideArg === undefined) {
    return toolError('entity_id needs side ("ar" for a customer, "ap" for a supplier)');
  }
  const byDate = strArg(args, 'by_date') ?? endOfMonth(appToday());
  const sides: Side[] = sideArg === undefined ? ['ar', 'ap'] : [sideArg as Side];

  try {
    // companyId from ctx ONLY.
    const results = await Promise.all(sides.map((s) => getDueByDate(ctx.companyId, s, byDate)));
    const out: Record<string, unknown> = { today: results[0]!.today, byDate };
    results.forEach((r) => { out[r.side === 'ar' ? 'receivables' : 'payables'] = shape(r, entityId); });
    if (results.length === 2) {
      out.netPosition = netPosition(results[0]!.totals, results[1]!.totals);
    }
    return ok(out);
  } catch (err) {
    if (err instanceof DueByDateInputError) return toolError(err.message);
    throw err;
  }
}

export const dueByDateTool: McpTool = {
  name: 'due_by_date',
  description:
    'What falls due by a date, per customer (receivables) and per supplier (payables), at TODAY\'s open balances. '
    + 'Per contact: overdueNow (due before today), dueTodayToDate (due today up to and including by_date), totalByDate (their sum: what must be settled by by_date), dueLater (due after by_date), noDueDate (no due date recorded, so it cannot be placed in time). '
    + 'totals are over EVERY contact. overdueNow + dueTodayToDate + dueLater + noDueDate = total = the aged_debtors / aged_creditors gross total; open customer disputes are held out of the columns (as the aging does) and shown as `disputed`. '
    + 'netPosition = receivables totalByDate minus payables totalByDate (only when both sides are returned). '
    + 'by_date defaults to the end of the current month and must be today or later. side "ar" or "ap" returns one side; omit for both. '
    + 'entity_id (with side) returns that one contact WITH its invoices, each carrying its dueDate (null when none recorded) and bucket. Without it contacts carry no invoices.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      by_date: { type: 'string', format: 'date', description: 'YYYY-MM-DD, today or later; defaults to the end of the current month' },
      side: { type: 'string', enum: ['ar', 'ap'], description: 'ar = customers, ap = suppliers; omit for both' },
      entity_id: { type: 'string', description: 'One customer or supplier id (needs side): returns that contact with its invoices.' },
    },
    additionalProperties: false as const,
  },
  handler,
};
