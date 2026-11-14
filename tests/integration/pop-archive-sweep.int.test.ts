/**
 * POP SharePoint archive on real PostgreSQL (migration 992 + popArchiveSweep / popSweeps as app_service),
 * Graph stubbed through the injected fetch (no network):
 *   - each POP is uploaded once under its archive path and recorded; a second tick uploads nothing;
 *   - a 409 records the existing item; a 5xx records nothing and is retried next tick;
 *   - a PDF over 4 MB is recorded 'too_large' and never uploaded;
 *   - no target row: no request, and the company is not listed (credentials: popSweeps.test.ts);
 *   - app_user cannot write pop_archive_targets / pop_trusted_payers, nor edit or delete a copy record.
 *
 * Fixture route: isaflow_test (assertNotProductionDb).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { asAppUser, asService, seedPop, setUpPopFixture, tearDownPopFixture, type PopFixture } from './helpers/popSweepFixture';

const h = vi.hoisted(() => ({ large: new Set<string>() }));
vi.mock('@/lib/documentStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documentStorage')>()),
  fetchRawBytes: vi.fn(async (documentId: string) => {
    const buffer = h.large.has(documentId) ? Buffer.alloc(4 * 1024 * 1024 + 1) : Buffer.from(`%PDF-1.4 ${documentId}`);
    return { buffer, hash: 'h', storedHash: 'h', size: buffer.length, fileType: 'application/pdf' };
  }),
}));

import { companiesWithUnarchivedPops, sweepPopArchive } from '@/modules/accounting/services/capture/pop/popArchiveSweep';
import { PopGraphClient } from '@/modules/accounting/services/capture/pop/popGraphClient';

const url = process.env.DATABASE_URL ?? '';
const describeIfDb = url && !url.includes('dummy') ? describe : describe.skip;
const pool = new Pool({ connectionString: url, max: 3 });
const [A, B] = [crypto.randomUUID(), crypto.randomUUID()];
let fx: PopFixture;

/** A Graph stand-in: the token endpoint, then `put(path)` decides each upload's status. */
function fakeGraph(put: (path: string) => number) {
  const puts: string[] = [];
  const fetchFn = async (u: string, init?: RequestInit): Promise<Response> => {
    if (u.startsWith('https://login.microsoftonline.com/')) return Response.json({ access_token: 't', expires_in: 3600 });
    const path = decodeURIComponent(u.split('/drive/root:/')[1]!.split(':/content')[0]!);
    if (init?.method === 'GET') return Response.json({ id: `existing:${path}`, webUrl: `https://sp/${path}` });
    puts.push(path);
    const status = put(path);
    return status === 201 ? Response.json({ id: `new:${path}`, webUrl: `https://sp/${path}` }, { status }) : Response.json({}, { status });
  };
  const client = new PopGraphClient({ tenantId: 'tn', clientId: 'cl', clientSecret: 'sc' }, fetchFn, Date.now, new Map());
  return { client, puts };
}

const copies = async (company: string) => (await pool.query(
  'SELECT proof_of_payment_id, outcome, drive_item_id, path FROM pop_archive_copies WHERE company_id = $1 ORDER BY path', [company])).rows;

describeIfDb('POP archive: copy each POP to SharePoint once', () => {
  beforeAll(async () => {
    assertNotProductionDb('pop-archive-sweep inserts companies, proofs of payment and archive config');
    fx = await setUpPopFixture(pool, [A, B]);
    await pool.query("INSERT INTO pop_archive_targets (company_id, site_id, folder_path) VALUES ($1, 'site-a', 'Proof of Payments')", [A]);
  });

  afterAll(async () => {
    try { await tearDownPopFixture(fx); } finally { await pool.end(); }
  });

  it('uploads each POP once under its path, records 409 as the existing item, and too_large without uploading', async () => {
    const one = await seedPop(fx, A, { beneficiary: 'Amoepong Bed and Bre', date: '2026-11-13' });
    const two = await seedPop(fx, A, { beneficiary: 'Tintswalo G Mabehla', date: '2026-10-30', amount: '40.00' });
    const big = await seedPop(fx, A, { beneficiary: 'Large Scan', date: '2026-11-01' });
    h.large.add(big.documentId);
    const txn = async (popId: string) => (await pool.query('SELECT transaction_number FROM proof_of_payments WHERE id = $1', [popId])).rows[0].transaction_number;
    const pathTwo = `Proof of Payments/2026/10/2026-10-30 Tintswalo G Mabehla R40.00 ${await txn(two.popId)}.pdf`;
    const g = fakeGraph((p) => (p === pathTwo ? 409 : 201));

    expect(await asService(pool, () => sweepPopArchive(A, g.client))).toEqual({ archived: 2, tooLarge: 1, failed: 0 });
    const pathOne = `Proof of Payments/2026/11/2026-11-13 Amoepong Bed and Bre R3000.00 ${await txn(one.popId)}.pdf`;
    expect(g.puts.sort()).toEqual([pathOne, pathTwo].sort());
    expect(await copies(A)).toEqual(expect.arrayContaining([
      { proof_of_payment_id: one.popId, outcome: 'archived', drive_item_id: `new:${pathOne}`, path: pathOne },
      { proof_of_payment_id: two.popId, outcome: 'archived', drive_item_id: `existing:${pathTwo}`, path: pathTwo },
      expect.objectContaining({ proof_of_payment_id: big.popId, outcome: 'too_large', drive_item_id: null }),
    ]));

    const again = fakeGraph(() => 201);
    expect(await asService(pool, () => sweepPopArchive(A, again.client))).toEqual({ archived: 0, tooLarge: 0, failed: 0 });
    expect(again.puts).toEqual([]);
  });

  it('records nothing on a 5xx and uploads it again next tick', async () => {
    const pop = await seedPop(fx, A, { beneficiary: 'Graph Down Ltd', date: '2026-11-12' });
    const down = fakeGraph(() => 503);
    expect(await asService(pool, () => sweepPopArchive(A, down.client))).toEqual({ archived: 0, tooLarge: 0, failed: 1 });
    expect((await copies(A)).map((c) => c.proof_of_payment_id)).not.toContain(pop.popId);
    const up = fakeGraph(() => 201);
    expect(await asService(pool, () => sweepPopArchive(A, up.client))).toEqual({ archived: 1, tooLarge: 0, failed: 0 });
    expect(up.puts).toHaveLength(1);
  });

  it('makes no request for a company without a target, and lists only companies with a target', async () => {
    await seedPop(fx, B, { beneficiary: 'No Target Co', date: '2026-11-12' });
    await seedPop(fx, A, { beneficiary: 'Waiting Co', date: '2026-11-12' });
    const g = fakeGraph(() => 201);
    expect(await asService(pool, () => sweepPopArchive(B, g.client))).toEqual({ archived: 0, tooLarge: 0, failed: 0 });
    expect(g.puts).toEqual([]);
    const listed = await asService(pool, () => companiesWithUnarchivedPops());
    expect(listed).toContain(A);
    expect(listed).not.toContain(B);
  });

  it('app_user reads the config but cannot write it, nor edit or delete a copy record', async () => {
    expect(await asAppUser(fx, A, 'SELECT site_id FROM pop_archive_targets WHERE company_id = $1', [A])).toBe('ok:1');
    expect(await asAppUser(fx, B, 'SELECT site_id FROM pop_archive_targets WHERE company_id = $1', [A])).toBe('ok:0');
    // A copy record names its POP with the POP's company: B's session cannot claim A's POP as archived.
    const popA = await seedPop(fx, A, { beneficiary: 'Claim Check', date: '2026-11-12' });
    const claim = "INSERT INTO pop_archive_copies (company_id, proof_of_payment_id, outcome, path) VALUES ($1, $2, 'too_large', 'x')";
    expect(await asAppUser(fx, B, claim, [B, popA.popId])).toBe('23503');
    expect(await asAppUser(fx, A, claim, [A, popA.popId])).toBe('ok:1');
    for (const stmt of [
      "INSERT INTO pop_archive_targets (company_id, site_id, folder_path) VALUES ($1, 'x', 'y') ON CONFLICT DO NOTHING",
      "UPDATE pop_archive_targets SET site_id = 'evil' WHERE company_id = $1",
      'DELETE FROM pop_archive_targets WHERE company_id = $1',
      "INSERT INTO pop_trusted_payers (company_id, profile_name) VALUES ($1, 'EVIL PTY LTD')",
      "UPDATE pop_archive_copies SET drive_item_id = 'x' WHERE company_id = $1",
      'DELETE FROM pop_archive_copies WHERE company_id = $1',
    ]) expect([stmt, await asAppUser(fx, A, stmt, [A])]).toEqual([stmt, '42501']);
  });
});
