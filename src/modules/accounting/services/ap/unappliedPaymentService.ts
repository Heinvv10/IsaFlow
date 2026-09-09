import {fmtDate} from '@/lib/fmtDate';
import {loadUnappliedCashHistory,cashHistoryPage,type CashHistoryCoverage,type CashHistoryRow} from '../shared/unappliedCashHistory';

export interface UnappliedPaymentRow {
  paymentId: string;
  paymentNumber: string;
  paymentDate: string;
  supplierId: string | null;
  supplierName: string | null;
  paymentAmount: number;
  allocatedAmount: number;
  unappliedAmount: number;
  status: string;
  reference: string | null;
  description: string | null;
  /** The journal that put this cash on the control account, when there is one. */
  journalEntryId: string | null;
}

export interface UnappliedPaymentsResult {
  rows: UnappliedPaymentRow[];
  /** Payments with an unapplied remainder that this report could attribute. */
  rowsTotal: number;
  /** Every payment with an unapplied remainder, before the attribution filter. */
  universeTotal: number;
  /**
   * EVERY payment whose supplier cannot be resolved, not just the ones on this
   * page — the caller reports them as `excludedRows`, and the envelope's
   * completeness check (`rowsTotal + excluded === universeTotal`) only means
   * anything if the excluded set is complete. Capped at `UNATTRIBUTED_CAP`;
   * going over it raises a completeness fault, which is the correct outcome — a
   * book with hundreds of orphaned payments has a bigger problem than a
   * truncated list.
   */
  unattributed: UnappliedPaymentRow[];
  /** Sum of `unappliedAmount` over `rowsTotal` payments. Not just the page. */
  totalUnapplied: number;
  /** Sum over the unattributed ones, so the two figures can be added honestly. */
  totalUnattributed: number;
  /** MAX(created_at) of the rows consumed, as an ISO timestamp. Never now(). */
  postedThrough: string;
  /** Partial coverage means the reported totals omit unresolved historical cash. */
  historyCoverage: CashHistoryCoverage;
}

export interface UnappliedPaymentsOptions {
  /** Payments dated on or before this day, YYYY-MM-DD. */
  asAt: string;
  limit: number;
  /** Keyset cursor: `[payment_date, id]` of the last row served. */
  after?: { paymentDate: string; id: string } | null;
}

export async function getUnappliedPayments(companyId:string,opts:UnappliedPaymentsOptions):Promise<UnappliedPaymentsResult>{
 const history=await loadUnappliedCashHistory(companyId,'supplier',opts.asAt),page=cashHistoryPage(history.rows,opts);
 return{rows:page.page.map(mapRow),unattributed:page.orphans.map(mapRow),rowsTotal:page.rowsTotal,universeTotal:page.universeTotal,
  totalUnapplied:page.totalUnapplied,totalUnattributed:page.totalUnattributed,postedThrough:history.postedThrough,historyCoverage:history.historyCoverage};
}
function mapRow(row:CashHistoryRow):UnappliedPaymentRow{
 return{paymentId:String(row.id),paymentNumber:String(row.payment_number??''),paymentDate:fmtDate(row.payment_date as string|Date),
  supplierId:row.party_id==null?null:String(row.party_id),supplierName:row.party_name==null?null:String(row.party_name),
  paymentAmount:Number(row.total_amount),allocatedAmount:row.allocated_amount,unappliedAmount:row.unapplied_amount,status:String(row.status),
  reference:row.reference==null?null:String(row.reference),description:row.description==null?null:String(row.description),
  journalEntryId:row.gl_journal_entry_id==null?null:String(row.gl_journal_entry_id)};
}
