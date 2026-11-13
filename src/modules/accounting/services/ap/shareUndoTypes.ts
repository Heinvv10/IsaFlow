/** Types and the refusal of the undo-share plan (void_payment undo_share, step 6; see `shareUndoPlan.ts`). */
import type { JournalLineInput } from '../../types/gl.types';
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';

/** A refusal of the undo, typed so the MCP registry answers its message (code SUPPLIER_PAYMENT_REFUSED). */
export class ShareUndoRefusal extends SupplierPaymentRefusal {
  constructor(message: string, opts?: { retryable?: boolean }) {
    super(message, opts);
    this.name = 'ShareUndoRefusal';
  }
}

/** What the caller chose, beyond the share itself. */
export interface ShareUndoChoices {
  /**
   * How much of each of this payment's bills the share reversed. REQUIRED when the share debits the clearing
   * account by more than this payment applied (it carries other bills too, and its lines do not say which);
   * each amount at most what this payment applied to that bill; a bill left out is not undone. Trusted as given
   * beyond that and the share's per-account capacity: it must come from the share's own working.
   */
  undoAmounts?: readonly { billId: string; amount: number }[];
}

export interface ShareUndoJournalPlan {
  billId: string;
  billNumber: string;
  amount: number;
  reference: string;
  description: string;
  lines: JournalLineInput[];
}

export interface ShareUndoPlan {
  paymentId: string;
  paymentNumber: string | null;
  clearingAccount: { id: string; code: string | null; name: string | null };
  shareJournal: { id: string; entryNumber: string | null; entryDate: string };
  journals: ShareUndoJournalPlan[];
  /** What the undo journals give back in total. */
  total: number;
  /** What the void will take off the bills: the payment's allocations, checked against what it reports. */
  allocatedTotal: number;
  allocationRows: number;
}

export const undoShareReference = (paymentId: string, billId: string) => `undo-share:${paymentId}:${billId}`;
