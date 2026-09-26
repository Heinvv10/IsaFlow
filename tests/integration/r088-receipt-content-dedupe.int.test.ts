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
const race = vi.hoisted(() => ({
  documentId: '' as string,
  entered: null as (() => void) | null,
  release: null as Promise<void> | null,
}));
vi.mock('@/lib/neon', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/neon')>();
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const isClaim = /UPDATE\s+captured_documents\s+SET\s+posted_at\s*=\s*NOW\(\)/.test(strings.join(' '));
    if (isClaim && race.documentId && values.includes(race.documentId) && race.release) {
      const release = race.release;
      race.documentId = '';
      return original.sql(strings, ...values).then(async (rows) => {
        race.entered?.();
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
import { claimCapturedDocumentForPosting } from '@/modules/accounting/services/capture/captureRowLock';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  accounts, bankCredit, bytesHash, call, claimLineCount, company, employee, errorOf, journalCount, lockWaiters,
  otherCompany, pool, postedAt, purge, seed, upload, uploadToInbox, type Result,
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
  expect(error.details).toMatchObject({ code: 'DUPLICATE_RECEIPT', earlierDocumentId, matchedOn });
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

  it('posts a genuine repeat purchase once a person confirms it', async () => {
    const repeat = await upload('slip-waltons-1150', { total: 1150 });
    const before = await bankCredit();
    const confirmed = await receiptToJournal(repeat, { confirmDuplicate: true });
    expect(confirmed.state.statusCode).toBe(200);
    expect(await journalCount([repeat])).toBe(1);
    expect(await bankCredit()).toBe(before + 1150);
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

  it('refuses the capture inbox petty-cash post of a re-upload, and posts it on confirmation', async () => {
    const { documentId, eventId } = await uploadToInbox('slip-waltons-1150', { total: 1150 });
    const before = await bankCredit();
    const body = { glAccountId: accounts[company]!.office };

    expectDuplicateRefusal(await postExpense(eventId, body), original, 'file');
    expect(await journalCount([documentId])).toBe(0);
    expect(await postedAt(documentId)).toBeNull();
    expect(await bankCredit()).toBe(before);

    expect((await postExpense(eventId, { ...body, confirmDuplicate: true })).state.statusCode).toBe(200);
    expect(await journalCount([documentId])).toBe(1);
  });

  it('refuses the capture inbox expense-claim post of a re-upload', async () => {
    const { documentId, eventId } = await uploadToInbox('slip-waltons-1150', { total: 1150 });
    const body = { employeeId: employee, glAccountId: accounts[company]!.office };

    expectDuplicateRefusal(await postExpense(eventId, body), original, 'file');
    expect(await claimLineCount(documentId)).toBe(0);
    expect(await postedAt(documentId)).toBeNull();

    expect((await postExpense(eventId, { ...body, confirmDuplicate: true })).state.statusCode).toBe(200);
    expect(await claimLineCount(documentId)).toBe(1);
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

  it('lands exactly one of two concurrent posts of the same bytes', async () => {
    const first = await upload('slip-waltons-2300', { total: 2300 });
    const second = await upload('slip-waltons-2300', { total: 2300 });
    let letGo!: () => void;
    const entered = new Promise<void>((resolve) => { race.entered = resolve; });
    race.release = new Promise<void>((resolve) => { letGo = resolve; });
    race.documentId = first;

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

    expect(await journalCount([first, second])).toBe(1);
    expect(ra.state.statusCode).toBe(200);
    expectDuplicateRefusal(rb, first, 'file');
    expect(await postedAt(second)).toBeNull();
    // The window was entered: B reached the database while A held its claim open.
    expect(parked).toBe(true);
  });
});

// The fence behind the check: a posting path that forgets to ask — or one
// written later — still cannot land a second live claim on the same content.
describe('R-088 backstop: the partial unique indexes on the posted fingerprint', () => {
  it('refuses a second live claim on the same bytes and admits a confirmed repeat', async () => {
    const [x1, x2, x3] = [
      await upload('slip-backstop', { total: 920 }),
      await upload('slip-backstop', { total: 920 }),
      await upload('slip-backstop', { total: 920 }),
    ];
    const fingerprint = { contentSha256: bytesHash('slip-backstop'), receiptKey: null, duplicateOf: null };
    expect(await claimCapturedDocumentForPosting(company, x1, null, fingerprint)).toBeNull();
    await expect(claimCapturedDocumentForPosting(company, x2, null, fingerprint))
      .rejects.toThrow(/uq_captured_documents_posted_content/);
    expect(await postedAt(x2)).toBeNull();
    expect(await claimCapturedDocumentForPosting(company, x3, null, { ...fingerprint, duplicateOf: x1 })).toBeNull();
  });

  it('refuses a second live claim on the same receipt key', async () => {
    const [y1, y2] = [await upload('slip-key-1', { total: 910 }), await upload('slip-key-2', { total: 910 })];
    const key = 'v1|backstop|2026-09-26|91000|11870';
    expect(await claimCapturedDocumentForPosting(company, y1, null,
      { contentSha256: bytesHash('slip-key-1'), receiptKey: key, duplicateOf: null })).toBeNull();
    await expect(claimCapturedDocumentForPosting(company, y2, null,
      { contentSha256: bytesHash('slip-key-2'), receiptKey: key, duplicateOf: null }))
      .rejects.toThrow(/uq_captured_documents_posted_receipt_key/);
  });
});
