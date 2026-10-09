/**
 * The shapes of a bank allocation (bankAllocationService): its type, what a
 * supplier/customer line's cash settled, and a split line.
 */
import type { AutoApplyMode } from '../shared/autoAllocateStrategy';

export type AllocationType = 'account' | 'supplier' | 'customer' | 'transfer';

/**
 * What a line's cash actually settled, for the caller to report back.
 *
 * Present on every supplier payment and customer receipt that named no
 * document — including under `auto_apply: 'none'`, where `applications` is
 * empty and `onAccount` is the whole line. A caller that cannot tell "applied
 * nothing" from "was never asked to" cannot explain the balance to its user.
 */
export interface AllocationApplicationResult {
  autoApply: AutoApplyMode;
  applications: { documentId: string; documentNumber: string; amount: number }[];
  /** The unapplied remainder left sitting on the contact's account. */
  onAccount: number;
}

export interface SplitLine {
  contraAccountId: string;
  amount: number;
  description?: string;
  vatCode?: string;
  /** Stamped on this line's contra (cost/revenue) line only — never on bank or VAT. */
  cc1Id?: string;
  cc2Id?: string;
  buId?: string;
}
