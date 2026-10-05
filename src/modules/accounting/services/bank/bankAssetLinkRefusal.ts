/**
 * The HTTP answer to a refused asset / fleet link (`bankAssetLinkService.setBankLineLink`), shared by
 * `bank-match-asset` and `bank-match-fleet` so both routes answer alike.
 *
 * A target that is missing and one that belongs to another company get the SAME 404 — no id in it, so the answer
 * says nothing about another tenant's records.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { BankTransactionNotPostedError } from './bankFeedStateGuard';
import type { BankLinkRefusal } from './bankAssetLinkService';
import type { BankTxLinkKind } from './bankTxLink';

const TARGET: Record<BankTxLinkKind, string> = { asset: 'Asset', fuel: 'Fuel record', service: 'Service record' };

export function respondLinkRefusal(
  res: NextApiResponse, refusal: BankLinkRefusal, kind: BankTxLinkKind, bankTxId: string,
): void {
  if (refusal.refused === 'line') return apiResponse.notFound(res, 'Bank transaction');
  if (refusal.refused === 'target') return apiResponse.notFound(res, TARGET[kind]);
  if (refusal.refused === 'no_link') {
    return apiResponse.conflict(res, `This bank transaction carries no ${TARGET[kind].toLowerCase()} link`);
  }
  return apiResponse.conflict(res, new BankTransactionNotPostedError(bankTxId, refusal.feedState, 'link').message);
}
