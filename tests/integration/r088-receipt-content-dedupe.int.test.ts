// R-088: the same receipt uploaded twice posted twice.
//
// Every upload is a new captured_documents row, so the per-document fences
// (R-058's row lock, the `posted_at` claim of K-072) never see the second one:
// re-uploading a slip, or the same slip arriving by email AND WhatsApp, booked
// the expense and the bank credit again with no refusal. Each case below is an
// upload sequence driven through the posting routes, asserting the ledger
// outcome — journals, bank credit, expense claim lines — not a guard's presence.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The race window: request A is held right after its posting claim — locks
// taken, claim written, nothing committed — while request B runs.
const hold = vi.hoisted(() => ({
  documentId: '' as string,
  entered: null as (() => void) | null,
  release: null as Promise<void> | null,
}));
vi.mock('@/lib/neon', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/neon')>();
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const isClaim = /UPDATE\s+captured_documents\s+SET\s+posted_at\s*=\s*NOW\(\)/.test(strings.join(' '));
    if (isClaim && hold.documentId && values.includes(hold.documentId) && hold.release) {
      const release = hold.release;
      hold.documentId = '';
      return original.sql(strings, ...values).then(async (rows) => {
        hold.entered?.();
        await release;
        return rows;
      });
    }
    return original.sql(strings, ...values);
  };
  Object.assign(sql, {
    transaction: original.sql.transaction,
    unsafe: original.sql.unsafe,
    query: original.sql.query,
  });
  return { ...original, sql };
});

import receiptRoute from '../../pages/api/accounting/receipt-to-journal';
import postExpenseRoute from '../../pages/api/accounting/capture/[id]/post-expense';
import actionRoute from '../../pages/api/accounting/document-capture-action';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  accounts, bankCredit, call, claimLineCount, company, employee, errorOf, journalCount, lockWaiters,
  otherCompany, pool, postedAt, purge, seed, stamped, upload, uploadToInbox, user, type Result,
} from './r088-receipt-content-dedupe.helpers';

assertDisposable();

const receiptToJournal = (documentId: string, extra: Record<string, unknown> = {}, owner = company) =>
  call(receiptRoute, '/api/accounting/receipt-to-journal', { documentId, ...extra }, undefined, owner);
const postExpense = (eventId: string, body: Record<string, unknown>) =>
  call(postExpenseRoute, `/api/accounting/capture/${eventId}/post-expense`, body, eventId);
const reject = (documentId: string) =>
  call(actionRoute, '/api/accounting/document-capture-action', { id: documentId, action: 'reject' });

function expectDuplicateRefusal(result: Result, earlierDocumentId: string, matchedOn: 'file' | 'details') {
  expect(result.state.statusCode).toBe(409);
  const error = errorOf(result);
  // Only a details match can be confirmed as a repeat: the same file is the same slip.
  expect(error.details).toMatchObject({ code: 'DUPLICATE_RECEIPT', earlierDocumentId, matchedOn, canConfirm: matchedOn === 'details' });
  expect(error.message).toContain(`r088-${earlierDocumentId.slice(0, 8)}.jpg`);
}

beforeAll(seed);
afterAll(async () => {
  try { await purge(); } finally { clearSystemAccountCache(); await pool.end(); }
}, 60_000);

describe('R-088 a receipt posts once however many times it is uploaded', () => {
  let original = '';

  it('refuses a byte-identical re-upload and writes nothing for it', async () => {
    original = await upload('slip-waltons-1150', { total: 1150 });
    const reupload = await upload('slip-waltons-1150', { total: 1150 });
    expect((await receiptToJournal(original)).state.statusCode).toBe(200);
    const creditAfterFirst = await bankCredit();
    expect(creditAfterFirst).toBe(1150);

    expectDuplicateRefusal(await receiptToJournal(reupload), original, 'file');
    expect(await journalCount([reupload])).toBe(0);
    expect(await postedAt(reupload)).toBeNull();
    expect(await bankCredit()).toBe(creditAfterFirst);
  });

  it('refuses the same slip in different bytes (email vs WhatsApp) on vendor, date, total and VAT', async () => {
    const forwarded = await upload('slip-waltons-1150-recompressed', { total: 1150, vendor: 'WALTONS STATIONERY (PTY) LTD.' });
    expectDuplicateRefusal(await receiptToJournal(forwarded), original, 'details');
    expect(await journalCount([forwarded])).toBe(0);
  });

  it('refuses to let a person confirm a byte-identical re-upload as a repeat', async () => {
    const reupload = await upload('slip-waltons-1150', { total: 1150 });
    const before = await bankCredit();
    expectDuplicateRefusal(await receiptToJournal(reupload, { confirmDuplicate: true }), original, 'file');
    expect(await journalCount([reupload])).toBe(0);
    expect(await postedAt(reupload)).toBeNull();
    expect(await bankCredit()).toBe(before);
  });

  it('posts a genuine repeat purchase once a person confirms it, and records who did', async () => {
    const repeat = await upload('slip-waltons-1150-second-coffee', { total: 1150 });
    expectDuplicateRefusal(await receiptToJournal(repeat), original, 'details');
    const before = await bankCredit();
    const confirmed = await receiptToJournal(repeat, { confirmDuplicate: true });
    expect(confirmed.state.statusCode).toBe(200);
    expect(await journalCount([repeat])).toBe(1);
    expect(await bankCredit()).toBe(before + 1150);
    expect(await stamped(repeat)).toMatchObject({ duplicate_of: original, confirmed_by: user });
  });

  it('posts a same-total receipt from the same vendor that printed a different slip number', async () => {
    // Two genuine purchases: same vendor, day, total and VAT, two slip numbers.
    const morning = await upload('slip-waltons-805-a', { total: 805, reference: 'TS-4471' });
    const afternoon = await upload('slip-waltons-805-b', { total: 805, reference: 'TS-4502' });
    expect((await receiptToJournal(morning)).state.statusCode).toBe(200);
    expect((await receiptToJournal(afternoon)).state.statusCode).toBe(200);
    expect(await journalCount([morning, afternoon])).toBe(2);
    // A copy of the morning slip that lost its number in the read is still refused.
    const copy = await upload('slip-waltons-805-a-photo', { total: 805 });
    expectDuplicateRefusal(await receiptToJournal(copy), morning, 'details');
  });

  it('does not read two rows with no stored hash as the same file', async () => {
    const first = await upload(null, { total: 690, reference: 'TS-5001' });
    const second = await upload(null, { total: 690, reference: 'TS-5002' });
    expect((await receiptToJournal(first)).state.statusCode).toBe(200);
    expect((await receiptToJournal(second)).state.statusCode).toBe(200);
  });

  it('still posts a different receipt', async () => {
    const other = await upload('slip-waltons-575', { total: 575 });
    expect((await receiptToJournal(other)).state.statusCode).toBe(200);
    expect(await journalCount([other])).toBe(1);
  });

  it('does not match another company\'s identical receipt', async () => {
    clearSystemAccountCache(otherCompany);
    const neighbours = await upload('slip-waltons-1150', { total: 1150 }, otherCompany);
    expect((await receiptToJournal(neighbours, {}, otherCompany)).state.statusCode).toBe(200);
    expect(await bankCredit(otherCompany)).toBe(1150);
  });

  it('refuses the capture inbox petty-cash post of a re-upload, confirmed or not', async () => {
    const { documentId, eventId } = await uploadToInbox('slip-waltons-1150', { total: 1150 });
    const before = await bankCredit();
    const body = { glAccountId: accounts[company]!.office };

    expectDuplicateRefusal(await postExpense(eventId, body), original, 'file');
    expectDuplicateRefusal(await postExpense(eventId, { ...body, confirmDuplicate: true }), original, 'file');
    expect(await journalCount([documentId])).toBe(0);
    expect(await postedAt(documentId)).toBeNull();
    expect(await bankCredit()).toBe(before);

    // A different photo of a same-looking purchase is a person's call.
    const repeat = await uploadToInbox('slip-waltons-1150-petty-repeat', { total: 1150 });
    expectDuplicateRefusal(await postExpense(repeat.eventId, body), original, 'details');
    expect((await postExpense(repeat.eventId, { ...body, confirmDuplicate: true })).state.statusCode).toBe(200);
    expect(await journalCount([repeat.documentId])).toBe(1);
    expect(await stamped(repeat.documentId)).toMatchObject({ duplicate_of: original, confirmed_by: user });
  });

  it('refuses the capture inbox expense-claim post of a re-upload, confirmed or not', async () => {
    const { documentId, eventId } = await uploadToInbox('slip-waltons-1150', { total: 1150 });
    const body = { employeeId: employee, glAccountId: accounts[company]!.office };

    expectDuplicateRefusal(await postExpense(eventId, body), original, 'file');
    expectDuplicateRefusal(await postExpense(eventId, { ...body, confirmDuplicate: true }), original, 'file');
    expect(await claimLineCount(documentId)).toBe(0);
    expect(await postedAt(documentId)).toBeNull();

    const repeat = await uploadToInbox('slip-waltons-1150-claim-repeat', { total: 1150 });
    expect((await postExpense(repeat.eventId, { ...body, confirmDuplicate: true })).state.statusCode).toBe(200);
    expect(await claimLineCount(repeat.documentId)).toBe(1);
    expect(await stamped(repeat.documentId)).toMatchObject({ duplicate_of: original, confirmed_by: user });
  });

  it('a slip posted from the capture inbox refuses a re-encoded copy on the other route', async () => {
    // Both inbox branches must RECORD the key they posted under, or the copy
    // (different bytes) finds nothing to match.
    const office = accounts[company]!.office;
    const pettyCash = await uploadToInbox('slip-cna-1265', { total: 1265, vendor: 'CNA' });
    expect((await postExpense(pettyCash.eventId, { glAccountId: office })).state.statusCode).toBe(200);
    const claimed = await uploadToInbox('slip-cna-1380', { total: 1380, vendor: 'CNA' });
    expect((await postExpense(claimed.eventId, { employeeId: employee, glAccountId: office })).state.statusCode).toBe(200);

    const pettyCopy = await upload('slip-cna-1265-scan', { total: 1265, vendor: 'CNA (Pty) Ltd' });
    expectDuplicateRefusal(await receiptToJournal(pettyCopy), pettyCash.documentId, 'details');
    const claimCopy = await upload('slip-cna-1380-scan', { total: 1380, vendor: 'CNA (Pty) Ltd' });
    expectDuplicateRefusal(await receiptToJournal(claimCopy), claimed.documentId, 'details');
  });

  it('frees the fingerprint when the earlier posting is undone', async () => {
    // confidence 0.5 leaves a draft; rejecting the document discards it and
    // releases the claim, so the slip was never booked and the re-upload posts.
    const draft = await upload('slip-waltons-3450', { total: 3450, confidence: 0.5 });
    expect((await receiptToJournal(draft)).state.statusCode).toBe(200);
    expect((await reject(draft)).state.statusCode).toBe(200);
    expect(await postedAt(draft)).toBeNull();

    const reupload = await upload('slip-waltons-3450', { total: 3450, confidence: 0.5 });
    expect((await receiptToJournal(reupload)).state.statusCode).toBe(200);
    expect(await journalCount([reupload])).toBe(1);
  });

  // Request A is held right after its claim, locks taken and nothing committed,
  // while request B runs; B must wait for A, then read A's posting and refuse.
  async function race(first: string, second: string) {
    let letGo!: () => void;
    const entered = new Promise<void>((resolve) => { hold.entered = resolve; });
    hold.release = new Promise<void>((resolve) => { letGo = resolve; });
    hold.documentId = first;

    const a = receiptToJournal(first);
    await entered;
    const b = receiptToJournal(second);
    let parked = false;
    for (let i = 0; i < 50 && !parked; i++) {
      parked = (await lockWaiters()) > 0;
      if (!parked) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    letGo();
    const [ra, rb] = await Promise.all([a, b]);
    return { ra, rb, parked };
  }

  it('lands exactly one of two concurrent posts of the same bytes', async () => {
    const first = await upload('slip-waltons-2300', { total: 2300 });
    const second = await upload('slip-waltons-2300', { total: 2300 });
    const { ra, rb, parked } = await race(first, second);

    expect(await journalCount([first, second])).toBe(1);
    expect(ra.state.statusCode).toBe(200);
    expectDuplicateRefusal(rb, first, 'file');
    expect(await postedAt(second)).toBeNull();
    // The window was entered: B reached the database while A held its claim open.
    expect(parked).toBe(true);
  });

  it('lands exactly one of two concurrent posts of one slip in different bytes', async () => {
    // Different files, one vendor/date/total/VAT: only the key lock orders them.
    const first = await upload('slip-waltons-2530-email', { total: 2530 });
    const second = await upload('slip-waltons-2530-whatsapp', { total: 2530, vendor: 'Waltons Stationery (Pty) Ltd' });
    const { ra, rb, parked } = await race(first, second);

    expect(await journalCount([first, second])).toBe(1);
    expect(ra.state.statusCode).toBe(200);
    expectDuplicateRefusal(rb, first, 'details');
    expect(parked).toBe(true);
  });
});
