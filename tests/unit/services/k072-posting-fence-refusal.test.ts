/**
 * The posting fence's read guard, as a table.
 *
 * `refusalForPosting` is the whole reason the three routes now agree: it is one
 * function reading one column, and every route asks it rather than spelling its
 * own predicate. The three defects it replaces were each a route spelling a
 * DIFFERENT predicate over the overloaded lifecycle column —
 *   - `status === 'matched'` refused a document merely ATTACHED to a bank
 *     transaction, with the words "already posted to a journal" while zero
 *     journals existed;
 *   - `status <> 'matched'` ADMITTED the terminal 'rejected';
 *   - and nothing at all read the document on the inbox route.
 *
 * So the table below is not decoration. Each row is a lifecycle value crossed
 * with the claim, and the assertion is the ANSWER a route would give.
 */
import { describe, expect, it } from 'vitest';
import {
  CAPTURED_DOCUMENT_REFUSAL_MESSAGE,
  CapturedDocumentAlreadyPostedError,
  refusalForPosting,
} from '@/modules/accounting/services/capture/captureRowLock';

const CLAIMED = new Date('2026-09-10T08:00:00Z');

describe('K-072 refusalForPosting', () => {
  it.each([
    ['pending',  null,    null],
    ['reviewed', null,    null],
    // 'matched' with no claim is the evidence-attach case: attachCapturedDocToBankTx
    // stamps the lifecycle column and writes no ledger row. It must stay postable.
    ['matched',  null,    null],
    ['rejected', null,    'rejected'],
    ['pending',  CLAIMED, 'already_posted'],
    ['reviewed', CLAIMED, 'already_posted'],
    ['matched',  CLAIMED, 'already_posted'],
    // A claimed row that was somehow also rejected is already posted — the
    // ledger row exists, and that is the fact the operator has to be told.
    ['rejected', CLAIMED, 'already_posted'],
  ] as const)('status %s, posted_at %s → %s', (status, posted_at, expected) => {
    expect(refusalForPosting({ status, posted_at })).toBe(expected);
  });

  it('reads a posted_at that pg handed back as a string', () => {
    // pg returns Date objects from timestamptz columns, but the value also
    // travels as an ISO string through `lockCaptureEventForPosting`'s interface
    // and through JSON. A truthiness test on the wrong shape is how a fence
    // silently opens.
    expect(refusalForPosting({ status: 'pending', posted_at: '2026-09-10T08:00:00Z' }))
      .toBe('already_posted');
  });

  it('names the reason in the message the operator reads', () => {
    expect(CAPTURED_DOCUMENT_REFUSAL_MESSAGE.rejected).toMatch(/rejected/i);
    expect(CAPTURED_DOCUMENT_REFUSAL_MESSAGE.rejected).not.toMatch(/journal/i);
    expect(CAPTURED_DOCUMENT_REFUSAL_MESSAGE.already_posted).toMatch(/already posted/i);
  });

  it('carries the refusal through the thrown error', () => {
    const err = new CapturedDocumentAlreadyPostedError('rejected');
    expect(err.refusal).toBe('rejected');
    expect(err.message).toBe(CAPTURED_DOCUMENT_REFUSAL_MESSAGE.rejected);
    expect(new CapturedDocumentAlreadyPostedError().refusal).toBe('already_posted');
  });
});
