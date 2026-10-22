/**
 * The answers netcash/submit gives once a batch has been claimed or refused before the claim (AP-01): what each says
 * about whether Netcash was reached and whether the batch may be sent again. Split out of the route (300-line limit).
 */
import type { NextApiResponse } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import type { NetcashSubmitResult } from './netcashService';
import type { SettleResult } from './netcashSubmissionClaim';

/**
 * The claim was no longer 'pending' when Netcash answered (it was released while the send was in flight): 409. The
 * answer is on the row as lateSendResult; an accepted/unknown answer put a 'failed' row back (`reopened`), unless a
 * newer claim already holds the batch - then the batch may be paid twice, and both submissions are named.
 */
export function respondClaimLost(res: NextApiResponse, claimId: string, result: NetcashSubmitResult,
  settled: Extract<SettleResult, { kind: 'lost' }>): void {
  const details = { reason: 'CLAIM_RESOLVED_DURING_SEND', submissionId: claimId, status: settled.status, netcashOutcome: result.outcome,
    reopened: settled.reopened ?? false, newerSubmissionId: settled.newerSubmissionId ?? null };
  if (settled.newerSubmissionId !== undefined) {
    log.error('Netcash accepted a send whose claim was released, and a newer claim already holds the batch - it may be paid twice', {
      submissionId: claimId, newerSubmissionId: settled.newerSubmissionId, outcome: result.outcome, batchReference: result.batchReference,
    }, 'netcash-api');
    return apiResponse.conflict(res,
      `Netcash answered ${result.outcome} for submission ${claimId} after it was released, and the batch was sent again `
      + `(submission ${settled.newerSubmissionId ?? 'unknown'}): it may be paid twice. Check Netcash for both now.`, details);
  }
  log.error('Netcash claim was released while its send was in flight - answer kept as lateSendResult', {
    submissionId: claimId, outcome: result.outcome, batchReference: result.batchReference, rowStatus: settled.status, reopened: settled.reopened ?? false,
  }, 'netcash-api');
  return apiResponse.conflict(res, settled.reopened
    ? `This submission was released while it was being sent, but Netcash answered ${result.outcome}: it is ${settled.status} again, so `
      + 'the batch stays closed. Check Netcash for this batch.'
    : `This submission was resolved by an operator (now ${settled.status}) while it was being sent, so Netcash's answer `
      + `(${result.outcome}) was not applied. Check Netcash for this batch before doing anything else.`, details);
}

/** Netcash answered but neither settle confirmed recording it: 500 that says what Netcash answered (do not resend). */
export function respondAnswerNotRecorded(res: NextApiResponse, claimId: string, result: NetcashSubmitResult): void {
  if (result.fenced) {
    return apiResponse.error(res, ErrorCode.INTERNAL_ERROR,
      `Nothing was sent to Netcash (the send started too late to be safe), but recording that failed: submission ${claimId} may still be `
      + 'pending. Resolve it as failed once you have checked Netcash shows nothing for this batch, then submit it again.',
      { reason: 'NETCASH_ANSWER_NOT_RECORDED', submissionId: claimId, netcashOutcome: result.outcome, batchReference: null, fenced: true });
  }
  const ref = result.batchReference ? ` (Netcash reference ${result.batchReference})` : '';
  return apiResponse.error(res, ErrorCode.INTERNAL_ERROR,
    `Netcash answered ${result.outcome}${ref}, but the answer may not have been recorded yet: submission ${claimId} may still be pending, `
    + 'the batch stays closed, and the server keeps trying to record the answer for several minutes. Do not resend it - check the '
    + 'submission row and Netcash before doing anything, then resolve it if needed.',
    { reason: 'NETCASH_ANSWER_NOT_RECORDED', submissionId: claimId, netcashOutcome: result.outcome, batchReference: result.batchReference ?? null });
}

/** Refused before anything was claimed or sent (ap/netcashSendCapacity, the send lock): safe to try again. */
export function respondSendBusy(res: NextApiResponse, reason: 'sends' | 'company_sends' | 'connection' | 'lock'): void {
  if (reason === 'lock') {
    return apiResponse.conflict(res, 'Another Netcash send is in progress on this server. Nothing was sent - try again in a moment.',
      { reason: 'NETCASH_SEND_LOCK_BUSY' });
  }
  if (reason === 'company_sends') {
    return apiResponse.error(res, ErrorCode.SERVICE_UNAVAILABLE,
      "This company's other Netcash sends are still in progress. Nothing was sent - try again in a moment.",
      { reason: 'NETCASH_COMPANY_SENDS_BUSY' });
  }
  return apiResponse.error(res, ErrorCode.SERVICE_UNAVAILABLE,
    'Another Netcash send is in progress, or the server is busy. Nothing was sent - try again in a moment.',
    { reason: reason === 'sends' ? 'NETCASH_SENDS_BUSY' : 'NETCASH_CONNECTION_BUSY' });
}

/**
 * The sender-side fence refused the send (residual 3b): it started too late to be safe, nothing reached Netcash, the
 * claim is settled failed. Retryable - the batch may be submitted again.
 */
export function respondSendFenced(res: NextApiResponse, claimId: string, elapsedMs: number, rowStatus = 'failed'): void {
  log.warn('Netcash send refused by the fence - it started too late to be safe; nothing was sent', { submissionId: claimId, elapsedMs, rowStatus }, 'netcash-api');
  const next = rowStatus === 'failed'
    ? 'The batch can be submitted again.'
    : `Meanwhile an operator resolved this submission (now ${rowStatus}), so it was left as it is: check its status before submitting the batch again.`;
  return apiResponse.error(res, ErrorCode.SERVICE_UNAVAILABLE,
    `Nothing was sent to Netcash: the server was too slow to start this send safely (a send that waited too long could be paid twice). ${next}`,
    { reason: 'NETCASH_SEND_FENCED', submissionId: claimId, status: rowStatus });
}
