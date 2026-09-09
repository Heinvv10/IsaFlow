import {fmtDate} from '@/lib/fmtDate';
import {loadUnappliedCashHistory,cashHistoryPage,type CashHistoryCoverage,type CashHistoryRow} from '../shared/unappliedCashHistory';

export interface UnappliedReceiptRow {
  paymentId: string;
  paymentNumber: string;
  paymentDate: string;
  customerId: string | null;
  customerName: string | null;
  receiptAmount: number;
  allocatedAmount: number;
  unappliedAmount: number;
  status: string;
  reference: string | null;
  description: string | null;
  /** The journal that put this cash on the control account, when there is one. */
  journalEntryId: string | null;
}

export interface UnappliedReceiptsResult {
  rows: UnappliedReceiptRow[];
  /** Receipts with an unapplied remainder that this report could attribute. */
  rowsTotal: number;
  /** Omitted until an independent historical eligible-remainder count is available. */
  universeTotal?: number;
  /** Entire unattributed recognized-cash bucket (bounded at 500). Historical
   * unresolved cash is separately disclosed in historyCoverage; its amount is
   * never guessed or silently included in a synthetic universe claim. */
  unattributed: UnappliedReceiptRow[];
  /** Sum of `unappliedAmount` over `rowsTotal` receipts. Not just the page. */
  totalUnapplied: number;
  /** Sum over the unattributed ones, so the two figures can be added honestly. */
  totalUnattributed: number;
  /** MAX(created_at) of the rows consumed, as an ISO timestamp. Never now(). */
  postedThrough: string;
  /** Partial coverage means the reported totals omit unresolved historical cash. */
  historyCoverage: CashHistoryCoverage;
}

export interface UnappliedReceiptsOptions {
  /** Receipts dated on or before this day, YYYY-MM-DD. */
  asAt: string;
  limit: number;
  /** Keyset cursor: `[payment_date, id]` of the last row served. */
  after?: { paymentDate: string; id: string } | null;
}

export async function getUnappliedReceipts(companyId:string,opts:UnappliedReceiptsOptions):Promise<UnappliedReceiptsResult>{
 const history=await loadUnappliedCashHistory(companyId,'customer',opts.asAt),page=cashHistoryPage(history.rows,opts);
 return{rows:page.page.map(mapRow),unattributed:page.orphans.map(mapRow),rowsTotal:page.rowsTotal,
  totalUnapplied:page.totalUnapplied,totalUnattributed:page.totalUnattributed,postedThrough:history.postedThrough,historyCoverage:history.historyCoverage};
}
function mapRow(row:CashHistoryRow):UnappliedReceiptRow{
 return{paymentId:String(row.id),paymentNumber:String(row.payment_number??''),paymentDate:fmtDate(row.payment_date as string|Date),
  customerId:row.party_id==null?null:String(row.party_id),customerName:row.party_name==null?null:String(row.party_name),
  receiptAmount:Number(row.total_amount),allocatedAmount:row.allocated_amount,unappliedAmount:row.unapplied_amount,status:String(row.status),
  reference:row.reference==null?null:String(row.reference),description:row.description==null?null:String(row.description),
  journalEntryId:row.gl_journal_entry_id==null?null:String(row.gl_journal_entry_id)};
}
