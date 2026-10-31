/**
 * PRD-060: FibreFlow Accounting Module — Phase 3
 * AR Aging Report Service
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { calculateAgingBuckets, type AgingDetailInvoice } from '../../utils/aging';
import type { AgingBucket, AgingInvoice } from '../../types/ap.types';
import { fmtDate } from '@/lib/fmtDate';
import { fetchARAgingInvoices, UNKNOWN_CUSTOMER } from './arAgingInvoices';
import { fetchUnallocatedCreditNotes } from './arAgingCreditNotes';
type Row = DbRow;


/**
 * AR aging. The point-in-time reconstruction — how a past balance is derived,
 * every writer of amount_paid and whether it can be dated, and the four
 * documented limitations — lives in services/shared/agingRewind.ts, which both
 * this and the AP service build their rewind from. Read it before changing
 * anything about how `asAtDate` is handled here.
 */
export async function getARAging(companyId: string, asAtDate?: string): Promise<AgingBucket[]> {
  try {
    const asAt = asAtDate ? new Date(asAtDate) : new Date();
    if (asAtDate && isNaN(asAt.getTime())) {
      throw new Error(`Invalid asAtDate: "${asAtDate}"`);
    }
    // fmtDate, never toISOString: on this UTC+2 host a Date round-trip reports
    // the previous day, which would silently shift the as-at boundary.
    const asAtStr = asAtDate ?? fmtDate(asAt);
    // The rewind window's upper bound comes from the SAME clock as asAtStr,
    // not from CURRENT_DATE. The database session is UTC and the business runs
    // UTC+2, so between 22:00 and midnight SAST CURRENT_DATE is the PREVIOUS
    // day — settlement dated today would silently drop out of the window for
    // two hours every night, and the "window is empty when as-at is today"
    // invariant would hold only by two clocks happening to agree.
    const todayStr = fmtDate(new Date());

    // One query for the aging, its drill-down and the open-items export:
    // ar/arAgingInvoices (disputes included). An invoice is open here exactly
    // when it is open there.
    const invoices: AgingInvoice[] = await fetchARAgingInvoices(companyId, asAtStr, todayStr);

    invoices.push(...(await fetchUnallocatedCreditNotes(companyId, asAtStr)));

    return calculateAgingBuckets(invoices, asAt);
  } catch (err) {
    log.error('Failed to get AR aging', { error: err }, 'accounting');
    throw err;
  }
}

export async function getARAgingDetail(companyId: string, 
  clientId: string,
  asAtDate?: string
): Promise<{ client: { id: string; name: string }; invoices: AgingDetailInvoice[]; buckets: AgingBucket | null }> {
  try {
    const asAt = asAtDate ? new Date(asAtDate) : new Date();
    // The other three aging entry points guard this; this one did not, so
    // ?as_at=lol reached Postgres and came back as a 22007 date-format error
    // instead of a readable refusal.
    if (asAtDate && isNaN(asAt.getTime())) {
      throw new Error(`Invalid asAtDate: "${asAtDate}"`);
    }
    const asAtStr = asAtDate ?? fmtDate(asAt);
    // The rewind window's upper bound comes from the SAME clock as asAtStr,
    // not from CURRENT_DATE. The database session is UTC and the business runs
    // UTC+2, so between 22:00 and midnight SAST CURRENT_DATE is the PREVIOUS
    // day — settlement dated today would silently drop out of the window for
    // two hours every night, and the "window is empty when as-at is today"
    // invariant would hold only by two clocks happening to agree.
    const todayStr = fmtDate(new Date());

    const clientRows = (await sql`SELECT id, name AS name FROM customers WHERE id = ${clientId}::UUID AND company_id = ${companyId}`) as Row[];

    // The drill-down's row shape is unchanged: the export-only header fields stay out of it.
    const invoices: AgingDetailInvoice[] = (await fetchARAgingInvoices(companyId, asAtStr, todayStr, clientId))
      .map(({ invoiceDate: _d, reference: _r, ...inv }) => inv);

    // client_id has no foreign key: an open invoice can name no customer row, and the list shows
    // it under UNKNOWN_CUSTOMER with that id. Its drill-down is those invoices; an id with neither
    // a customer nor an open invoice (of this company) is not found.
    if (clientRows.length === 0 && invoices.length === 0) throw new Error(`Client ${clientId} not found`);

    const buckets = calculateAgingBuckets(invoices, asAt);
    return {
      client: clientRows[0] ? { id: String(clientRows[0].id), name: String(clientRows[0].name) } : { id: clientId, name: UNKNOWN_CUSTOMER },
      invoices,
      buckets: buckets.length > 0 ? buckets[0]! : null,
    };
  } catch (err) {
    log.error('Failed to get AR aging detail', { clientId, error: err }, 'accounting');
    throw err;
  }
}
