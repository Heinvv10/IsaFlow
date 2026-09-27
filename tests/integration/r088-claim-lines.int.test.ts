// R-088 round 3: manual expense-claim lines against the posted-content fence.
//
// `claimLineSourceDocuments` takes the rows and the fingerprints a route post
// takes, so it must take them in the SAME order (row, then fingerprint), or a
// claim line and a route post of one document deadlock. It must also tell a
// file uploaded twice apart from one document listed twice, and record the
// receipt key it booked so the receipt routes can match a re-encoded copy.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The route post is held after its row lock and before its fingerprint lock:
// the receipt check's first statement.
const hold = vi.hoisted(() => ({
  documentId: '' as string,
  entered: null as (() => void) | null,
  release: null as Promise<void> | null,
}));
vi.mock('@/lib/neon', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/neon')>();
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const isCheck = /^\s*SELECT raw_bytes_sha256 FROM captured_documents/.test(strings.join(' '));
    if (isCheck && hold.documentId && values.includes(hold.documentId) && hold.release) {
      const release = hold.release;
      hold.documentId = '';
      hold.entered?.();
      return release.then(() => original.sql(strings, ...values));
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
import claimsRoute from '../../pages/api/accounting/expense-claims';
import { als } from '@/lib/als';
import {
  ClaimSourceDocumentError,
  claimLineSourceDocuments,
} from '@/modules/accounting/services/expense/claimSourceDocuments';
import { receiptContentKey } from '@/modules/accounting/services/capture/receiptFingerprint';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  accounts, call, company, employee, errorOf, journalCount, lockWaiters, pool, postedAt, purge, seed,
  stamped, today, upload, user,
} from './r088-receipt-content-dedupe.helpers';

assertDisposable();

const receiptToJournal = (documentId: string) =>
  call(receiptRoute, '/api/accounting/receipt-to-journal', { documentId });
const createClaim = (lines: Array<[string, number]>) =>
  call(claimsRoute, '/api/accounting/expense-claims', {
    employeeId: employee,
    lines: lines.map(([sourceDocumentId, amount]) => ({
      lineDate: today, description: 'R088 slip', merchant: 'Waltons', amount, vatAmount: 0, vatCode: 'none',
      glAccountId: accounts[company]!.office, costCentreId: null, projectId: null, sourceDocumentId,
      kmTravelled: null, kmRate: null, mileageFrom: null, mileageTo: null,
    })),
  });

async function claimCount(): Promise<number> {
  return (await pool.query('SELECT COUNT(*)::int AS n FROM expense_claims WHERE company_id=$1', [company])).rows[0].n as number;
}

beforeAll(seed);
afterAll(async () => {
  try { await purge(); } finally { clearSystemAccountCache(); await pool.end(); }
}, 60_000);

describe('R-088 manual expense-claim lines', () => {
  it('refuses one file uploaded twice on two lines, in its own words', async () => {
    const [a, b] = [await upload('lines-4025', { total: 4025 }), await upload('lines-4025', { total: 4025 })];
    const before = await claimCount();
    const refused = await createClaim([[a, 4025], [b, 4025]]);
    expect(refused.state.statusCode, JSON.stringify(refused.state.body)).toBe(400);
    expect(errorOf(refused).message).toMatch(/same file.*uploaded twice/i);
    expect(await claimCount()).toBe(before);
    expect(await postedAt(a)).toBeNull();
    expect(await postedAt(b)).toBeNull();
  });

  it('records the receipt key it booked, so a re-encoded copy is refused on a receipt route', async () => {
    const onClaim = await upload('lines-4140-email', { total: 4140 });
    expect((await createClaim([[onClaim, 4140]])).state.statusCode).toBe(201);
    const key = receiptContentKey({ vendorName: 'Waltons Stationery', date: today, totalAmount: 4140, vatAmount: 540 });
    expect((await stamped(onClaim)).key).toBe(key);

    const copy = await upload('lines-4140-whatsapp', { total: 4140, vendor: 'WALTONS STATIONERY (PTY) LTD' });
    const refused = await receiptToJournal(copy);
    expect(refused.state.statusCode).toBe(409);
    expect(errorOf(refused).details).toMatchObject({ earlierDocumentId: onClaim, matchedOn: 'details' });
    expect(await journalCount([copy])).toBe(0);
  });

  it('takes the row before the fingerprint, as a route post does, so the two cannot deadlock', async () => {
    const doc = await upload('lines-4255', { total: 4255 });
    let letGo!: () => void;
    const entered = new Promise<void>((resolve) => { hold.entered = resolve; });
    hold.release = new Promise<void>((resolve) => { letGo = resolve; });
    hold.documentId = doc;

    // The route post holds the document row and is about to take its fingerprint.
    const post = receiptToJournal(doc);
    await entered;

    const client = await pool.connect();
    await client.query('BEGIN');
    const line = als.run({ client, userId: user, companyId: company, claims: {} } as never,
      () => claimLineSourceDocuments(company, [{ sourceDocumentId: doc }]))
      .then(() => null, (e: unknown) => e);
    let parked = false;
    for (let i = 0; i < 50 && !parked; i++) {
      parked = (await lockWaiters()) > 0;
      if (!parked) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    letGo();
    const posted = await post;
    const refusal = await line;
    await client.query('ROLLBACK');
    client.release();

    expect(posted.state.statusCode, JSON.stringify(posted.state.body)).toBe(200);
    expect(refusal).toBeInstanceOf(ClaimSourceDocumentError);
    expect((refusal as ClaimSourceDocumentError).refusal).toBe('already_posted');
    // The window was entered: the claim line waited on the route's row.
    expect(parked).toBe(true);
  }, 30_000);
});
