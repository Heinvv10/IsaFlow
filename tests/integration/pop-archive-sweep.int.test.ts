/**
 * POP SharePoint archive on real PostgreSQL (migration 992 + popArchiveSweep as app_service), Graph stubbed
 * through the injected fetch (no network):
 *   - each POP is uploaded once under its archive path and recorded; a second tick uploads nothing;
 *   - a 409 adopts the existing file only when it is a file whose bytes are ours; otherwise a counted attempt;
 *   - a PDF over 4 MB is recorded 'too_large' and never uploaded;
 *   - a POP's own failure (no bytes, no path, a refusal, a 403 on it) is counted, waits, goes behind the others,
 *     and after POP_ARCHIVE_MAX_ATTEMPTS is settled 'failed'; a 5xx waits and ends the tick but never counts, so
 *     a long outage cannot settle a good POP 'failed'; a second POP denied in one tick ends the tick uncounted;
 *   - throttling (429) and the deadline end the tick and count against no POP;
 *   - no target row: no request, and the company is not listed;
 *   - app_user cannot write pop_archive_targets / pop_trusted_payers, nor edit or delete a copy or attempt record.
 *
 * Fixture route: isaflow_test (assertNotProductionDb).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { asAppUser, asService, seedPop, setUpPopFixture, tearDownPopFixture, type PopFixture } from './helpers/popSweepFixture';

const h = vi.hoisted(() => ({
  large: new Set<string>(), missing: new Set<string>(), badPath: new Set<string>(),
  objectGone: new Set<string>(), storageDown: new Set<string>(),
}));
vi.mock('@/lib/documentStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documentStorage')>()),
  fetchRawBytes: vi.fn(async (documentId: string) => {
    if (h.missing.has(documentId)) return null;
    if (h.objectGone.has(documentId)) {
      const { CapturedDocumentMissingError } = await import('@/lib/supabaseStorage');
      throw new CapturedDocumentMissingError(`x/${documentId}`, 'Object not found');
    }
    if (h.storageDown.has(documentId)) throw new Error('Storage download failed: fetch failed');
    const buffer = h.large.has(documentId) ? Buffer.alloc(4 * 1024 * 1024 + 1) : Buffer.from(`%PDF-1.4 ${documentId}`);
    return { buffer, hash: 'h', storedHash: 'h', size: buffer.length, fileType: 'application/pdf' };
  }),
}));
vi.mock('@/modules/accounting/services/capture/pop/popArchiveName', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/capture/pop/popArchiveName')>();
  return { ...real, popArchivePath: vi.fn((folder: string, pop: Parameters<typeof real.popArchivePath>[1]) => {
    if (h.badPath.has(pop.beneficiary)) throw new Error('popArchivePath: amount is not 0.00-shaped');
    return real.popArchivePath(folder, pop);
  }) };
});

import {
  companiesWithUnarchivedPops, POP_ARCHIVE_MAX_ATTEMPTS, POP_ARCHIVE_TRIES_CEILING, sweepPopArchive,
} from '@/modules/accounting/services/capture/pop/popArchiveSweep';
import { PopGraphClient } from '@/modules/accounting/services/capture/pop/popGraphClient';

const url = process.env.DATABASE_URL ?? '';
const describeIfDb = url && !url.includes('dummy') ? describe : describe.skip;
const pool = new Pool({ connectionString: url, max: 3 });
const [A, B, Z] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
let fx: PopFixture;

/**
 * A Graph stand-in: the token endpoint, then `put(path)` decides each upload's status; the item lookup returns
 * `existing(path)`, and its content download `content(path)`.
 */
function fakeGraph(put: (path: string) => number, existing: (path: string) => object = () => ({}),
  content: (path: string) => Buffer = () => Buffer.alloc(0)) {
  const puts: string[] = [];
  const fetchFn = async (u: string, init?: RequestInit): Promise<Response> => {
    if (u.startsWith('https://login.microsoftonline.com/')) return Response.json({ access_token: 't', expires_in: 3600 });
    const path = decodeURIComponent(u.split('/drive/root:/')[1]!.split(/:\/content|\?\$select/)[0]!);
    if (init?.method === 'GET' && u.endsWith(':/content')) return new Response(new Uint8Array(content(path)), { status: 200 });
    if (init?.method === 'GET') return Response.json({ id: `existing:${path}`, webUrl: `https://sp/${path}`, ...existing(path) });
    puts.push(path);
    const status = put(path);
    return status === 201 ? Response.json({ id: `new:${path}`, webUrl: `https://sp/${path}` }, { status }) : Response.json({}, { status });
  };
  const client = new PopGraphClient({ tenantId: 'tn', clientId: 'cl', clientSecret: 'sc' }, fetchFn, Date.now, new Map());
  return { client, puts };
}
const run = (company: string, client: PopGraphClient, limit?: number, deadline?: number) =>
  asService(pool, () => sweepPopArchive(company, client, limit, deadline));
const copyOf = async (popId: string) => (await pool.query('SELECT outcome, drive_item_id, path FROM pop_archive_copies WHERE proof_of_payment_id = $1', [popId])).rows[0] ?? null;
const attemptsOf = async (popId: string) => (await pool.query('SELECT attempts, last_error FROM pop_archive_attempts WHERE proof_of_payment_id = $1', [popId])).rows[0] ?? null;
const age = (popId: string) => pool.query("UPDATE pop_archive_attempts SET last_attempt_at = now() - interval '2 days' WHERE proof_of_payment_id = $1", [popId]);
const txn = async (popId: string) => (await pool.query('SELECT transaction_number FROM proof_of_payments WHERE id = $1', [popId])).rows[0].transaction_number;

describeIfDb('POP archive: copy each POP to SharePoint once', () => {
  beforeAll(async () => {
    assertNotProductionDb('pop-archive-sweep inserts companies, proofs of payment and archive config');
    fx = await setUpPopFixture(pool, [A, B, Z]);
    await pool.query("INSERT INTO pop_archive_targets (company_id, site_id, folder_path) VALUES ($1, 'site-a', 'Proof of Payments'), ($2, 'site-z', 'POPs')", [A, Z]);
  });

  afterAll(async () => {
    try { await tearDownPopFixture(fx); } finally { await pool.end(); }
  });

  it('uploads each POP once, adopts an existing file with our bytes on 409, and records too_large without uploading', async () => {
    const one = await seedPop(fx, A, { beneficiary: 'Amoepong Bed and Bre', date: '2026-11-13' });
    const two = await seedPop(fx, A, { beneficiary: 'Tintswalo G Mabehla', date: '2026-10-30', amount: '40.00' });
    const big = await seedPop(fx, A, { beneficiary: 'Large Scan', date: '2026-11-01' });
    h.large.add(big.documentId);
    const pathOne = `Proof of Payments/2026/11/2026-11-13 Amoepong Bed and Bre R3000.00 ${await txn(one.popId)}.pdf`;
    const pathTwo = `Proof of Payments/2026/10/2026-10-30 Tintswalo G Mabehla R40.00 ${await txn(two.popId)}.pdf`;
    const twoBytes = Buffer.from(`%PDF-1.4 ${two.documentId}`); // what fetchRawBytes hands the sweep
    const g = fakeGraph((p) => (p === pathTwo ? 409 : 201), () => ({ size: twoBytes.length, file: {} }), () => twoBytes);

    expect(await run(A, g.client)).toEqual({ archived: 2, tooLarge: 1, failed: 0, stopped: 0 });
    expect(g.puts.sort()).toEqual([pathOne, pathTwo].sort());
    expect(await copyOf(one.popId)).toEqual({ outcome: 'archived', drive_item_id: `new:${pathOne}`, path: pathOne });
    expect(await copyOf(two.popId)).toEqual({ outcome: 'archived', drive_item_id: `existing:${pathTwo}`, path: pathTwo });
    expect(await copyOf(big.popId)).toMatchObject({ outcome: 'too_large', drive_item_id: null });

    const again = fakeGraph(() => 201);
    expect(await run(A, again.client)).toEqual({ archived: 0, tooLarge: 0, failed: 0, stopped: 0 });
    expect(again.puts).toEqual([]);
  });

  it('does not adopt an existing file of another size or other bytes, or a folder: a counted attempt instead', async () => {
    const pop = await seedPop(fx, Z, { beneficiary: 'Clash Co', date: '2026-11-12' });
    expect(await run(Z, fakeGraph(() => 409, () => ({ size: 1, file: {} })).client)).toMatchObject({ archived: 0, failed: 1 });
    expect(await copyOf(pop.popId)).toBeNull();
    expect(await attemptsOf(pop.popId)).toEqual({ attempts: 1, last_error: 'HTTP 409: exists_differs' });
    await age(pop.popId);
    const same = Buffer.from(`%PDF-1.4 ${pop.documentId}`).length;
    expect(await run(Z, fakeGraph(() => 409, () => ({ size: same, file: {} }), () => Buffer.alloc(same, 0x41)).client))
      .toMatchObject({ archived: 0, failed: 1 });
    expect(await attemptsOf(pop.popId)).toMatchObject({ attempts: 2 });
    await age(pop.popId);
    expect(await run(Z, fakeGraph(() => 409, () => ({ size: Buffer.from(`%PDF-1.4 ${pop.documentId}`).length, folder: {} })).client))
      .toMatchObject({ archived: 0, failed: 1 });
    expect(await copyOf(pop.popId)).toBeNull();
    await pool.query('DELETE FROM proof_of_payments WHERE id = $1', [pop.popId]); // out of the later tests' way
  });

  it('a 5xx ends the tick and waits, but never counts toward failed, and archives it when Graph is back', async () => {
    const pop = await seedPop(fx, A, { beneficiary: 'Graph Down Ltd', date: '2026-11-12' });
    const waiting = await seedPop(fx, A, { beneficiary: 'Graph Down Next', date: '2026-11-12' });
    const down = fakeGraph(() => 503);
    expect(await run(A, down.client)).toEqual({ archived: 0, tooLarge: 0, failed: 1, stopped: 1 });
    expect(down.puts).toHaveLength(1);
    const [first, second] = (await attemptsOf(pop.popId)) ? [pop, waiting] : [waiting, pop];
    expect(await attemptsOf(first.popId)).toMatchObject({ attempts: 0 });
    expect(await attemptsOf(second.popId)).toBeNull();

    const up = fakeGraph(() => 201);
    expect(await run(A, up.client)).toMatchObject({ archived: 1 }); // the other one; the failed one waits
    expect(await copyOf(second.popId)).toMatchObject({ outcome: 'archived' });
    expect(await copyOf(first.popId)).toBeNull();
    await age(first.popId);
    expect(await run(A, up.client)).toMatchObject({ archived: 1 });
    expect(await copyOf(first.popId)).toMatchObject({ outcome: 'archived' });
  });

  it('puts a POP that keeps failing behind the others, and settles it failed after the last attempt', async () => {
    const bad = await seedPop(fx, B, { beneficiary: 'No Bytes Co', date: '2026-11-01' });
    const badPath = await seedPop(fx, B, { beneficiary: 'Bad Path Co', date: '2026-11-02' });
    h.missing.add(bad.documentId);
    h.badPath.add('Bad Path Co');
    await pool.query("INSERT INTO pop_archive_targets (company_id, site_id, folder_path) VALUES ($1, 'site-b', 'POP')", [B]);
    const g = fakeGraph(() => 201);
    expect(await run(B, g.client, 2)).toMatchObject({ failed: 2, archived: 0 });
    const good = await seedPop(fx, B, { beneficiary: 'Good Co', date: '2026-11-03' });
    await age(bad.popId);
    await age(badPath.popId);
    expect(await run(B, g.client, 1)).toMatchObject({ archived: 1 }); // never tried goes first
    expect(await copyOf(good.popId)).toMatchObject({ outcome: 'archived' });
    expect(await attemptsOf(badPath.popId)).toEqual({ attempts: 1, last_error: 'popArchivePath: amount is not 0.00-shaped' });

    await pool.query('UPDATE pop_archive_attempts SET attempts = $2 - 1, tries = $2 - 1 WHERE proof_of_payment_id = $1', [bad.popId, POP_ARCHIVE_MAX_ATTEMPTS]);
    await age(bad.popId);
    await run(B, g.client);
    expect(await copyOf(bad.popId)).toMatchObject({ outcome: 'failed', drive_item_id: null });
    expect(await attemptsOf(bad.popId)).toEqual({ attempts: POP_ARCHIVE_MAX_ATTEMPTS, last_error: 'PDF bytes unavailable' });
    await age(bad.popId);
    await run(B, g.client);
    expect(await attemptsOf(bad.popId)).toMatchObject({ attempts: POP_ARCHIVE_MAX_ATTEMPTS }); // settled: not tried again
  });

  it('never settles a good POP failed through an outage: 12 Graph 5xx in a row leave it waiting, uncounted', async () => {
    const pop = await seedPop(fx, Z, { beneficiary: 'Long Outage Co', date: '2026-11-12' });
    for (let i = 0; i < 12; i += 1) {
      expect(await run(Z, fakeGraph(() => 503).client)).toMatchObject({ failed: 1, stopped: 1 });
      await age(pop.popId);
    }
    expect(await copyOf(pop.popId)).toBeNull();
    expect((await pool.query('SELECT attempts, tries FROM pop_archive_attempts WHERE proof_of_payment_id = $1', [pop.popId])).rows[0])
      .toEqual({ attempts: 0, tries: 12 });
    expect(await run(Z, fakeGraph(() => 201).client)).toMatchObject({ archived: 1 });
    expect(await copyOf(pop.popId)).toMatchObject({ outcome: 'archived' });
  });

  it('caps the backoff: a POP with any number of tries is retried at most ~21 h later, and tries stop at the ceiling', async () => {
    const huge = await seedPop(fx, Z, { beneficiary: 'Huge Tries Co', date: '2026-11-01' });
    const ten = await seedPop(fx, Z, { beneficiary: 'Ten Tries Co', date: '2026-11-02' });
    const recent = await seedPop(fx, Z, { beneficiary: 'Recent Tries Co', date: '2026-11-03' });
    await pool.query(`INSERT INTO pop_archive_attempts (company_id, proof_of_payment_id, attempts, tries, last_attempt_at, last_error)
      VALUES ($1, $2, 0, 100000, now() - interval '22 hours', 'x'), ($1, $3, 0, 10, now() - interval '22 hours', 'x'),
             ($1, $4, 0, 100000, now() - interval '20 hours', 'x')`, [Z, huge.popId, ten.popId, recent.popId]);
    const g = fakeGraph((p) => (p.includes('Huge Tries Co') ? 400 : 201)); // a failure that does not end the tick
    expect(await run(Z, g.client)).toMatchObject({ failed: 1 });
    expect(g.puts.some((p) => p.includes('Recent Tries Co'))).toBe(false); // 20 h < 5 min · 2^8
    expect(g.puts.filter((p) => !p.includes('Recent Tries Co'))).toHaveLength(2);
    expect(await copyOf(ten.popId)).toMatchObject({ outcome: 'archived' });
    expect((await pool.query('SELECT tries FROM pop_archive_attempts WHERE proof_of_payment_id = $1', [huge.popId])).rows[0].tries)
      .toBe(POP_ARCHIVE_TRIES_CEILING);
    await pool.query('DELETE FROM proof_of_payments WHERE id = ANY($1)', [[huge.popId, ten.popId, recent.popId]]);
  });

  it('counts a storage object that is gone against that POP; storage being down is an outage', async () => {
    const gone = await seedPop(fx, Z, { beneficiary: 'Object Gone Co', date: '2026-11-01' });
    const down = await seedPop(fx, Z, { beneficiary: 'Storage Down Co', date: '2026-11-02' });
    h.objectGone.add(gone.documentId);
    h.storageDown.add(down.documentId);
    expect(await run(Z, fakeGraph(() => 201).client)).toMatchObject({ failed: 2, archived: 0 });
    expect(await attemptsOf(gone.popId)).toMatchObject({ attempts: 1 });
    expect(await attemptsOf(down.popId)).toMatchObject({ attempts: 0 });
    await pool.query('DELETE FROM proof_of_payments WHERE id = ANY($1)', [[gone.popId, down.popId]]);
  });

  it('counts a 403 against that POP and moves on; a second POP denied in the same tick ends it uncounted', async () => {
    const one = await seedPop(fx, Z, { beneficiary: 'Denied File Co', date: '2026-11-10' });
    const two = await seedPop(fx, Z, { beneficiary: 'Allowed File Co', date: '2026-11-11' });
    expect(await run(Z, fakeGraph((p) => (p.includes('Denied File Co') ? 403 : 201)).client))
      .toEqual({ archived: 1, tooLarge: 0, failed: 1, stopped: 0 });
    expect(await attemptsOf(one.popId)).toEqual({ attempts: 1, last_error: 'HTTP 403: denied' });
    expect(await copyOf(two.popId)).toMatchObject({ outcome: 'archived' });
    await pool.query('DELETE FROM proof_of_payments WHERE id = ANY($1)', [[one.popId, two.popId]]);

    const a = await seedPop(fx, Z, { beneficiary: 'Grant Gone A', date: '2026-11-10' });
    const b = await seedPop(fx, Z, { beneficiary: 'Grant Gone B', date: '2026-11-11' });
    const c = await seedPop(fx, Z, { beneficiary: 'Grant Gone C', date: '2026-11-12' });
    const denied = fakeGraph(() => 403);
    expect(await run(Z, denied.client)).toEqual({ archived: 0, tooLarge: 0, failed: 1, stopped: 1 });
    expect(denied.puts).toHaveLength(2);
    const counted = await Promise.all([a, b, c].map((p) => attemptsOf(p.popId)));
    expect(counted.filter((r) => r !== null)).toEqual([{ attempts: 1, last_error: 'HTTP 403: denied' }]);
    await pool.query('DELETE FROM proof_of_payments WHERE id = ANY($1)', [[a.popId, b.popId, c.popId]]);
  });

  it('ends the tick on throttling or at the deadline, counting against no POP', async () => {
    const pop = await seedPop(fx, Z, { beneficiary: 'Throttled Co', date: '2026-11-12' });
    const g = fakeGraph(() => 429);
    expect(await run(Z, g.client)).toEqual({ archived: 0, tooLarge: 0, failed: 0, stopped: 1 });
    expect(g.puts).toHaveLength(1);
    expect(await attemptsOf(pop.popId)).toBeNull();
    const late = fakeGraph(() => 201);
    expect(await run(Z, late.client, undefined, Date.now() - 1)).toMatchObject({ archived: 0, stopped: 1 });
    expect(late.puts).toEqual([]);
    expect(await attemptsOf(pop.popId)).toBeNull();
  });

  it('makes no request for a company without a target, and lists only companies with a target', async () => {
    const C = crypto.randomUUID();
    fx.companies.push(C);
    await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [C, 'POP no target']);
    await seedPop(fx, C, { beneficiary: 'No Target Co', date: '2026-11-12' });
    const g = fakeGraph(() => 201);
    expect(await run(C, g.client)).toEqual({ archived: 0, tooLarge: 0, failed: 0, stopped: 0 });
    expect(g.puts).toEqual([]);
    await seedPop(fx, A, { beneficiary: 'Waiting Co', date: '2026-11-12' });
    const listed = await asService(pool, () => companiesWithUnarchivedPops());
    expect(listed).toContain(A);
    expect(listed).not.toContain(C);
  });

  it('app_user reads the config but cannot write it, nor edit or delete a copy or attempt record', async () => {
    expect(await asAppUser(fx, A, 'SELECT site_id FROM pop_archive_targets WHERE company_id = $1', [A])).toBe('ok:1');
    expect(await asAppUser(fx, Z, 'SELECT site_id FROM pop_archive_targets WHERE company_id = $1', [A])).toBe('ok:0');
    for (const stmt of [
      "INSERT INTO pop_archive_targets (company_id, site_id, folder_path) VALUES ($1, 'x', 'y') ON CONFLICT DO NOTHING",
      "UPDATE pop_archive_targets SET site_id = 'evil' WHERE company_id = $1",
      'DELETE FROM pop_archive_targets WHERE company_id = $1',
      "INSERT INTO pop_trusted_payers (company_id, profile_name) VALUES ($1, 'EVIL PTY LTD')",
      "UPDATE pop_archive_copies SET drive_item_id = 'x' WHERE company_id = $1",
      'DELETE FROM pop_archive_copies WHERE company_id = $1',
      'UPDATE pop_archive_attempts SET company_id = $1 WHERE company_id = $1',
      'DELETE FROM pop_archive_attempts WHERE company_id = $1',
    ]) expect([stmt, await asAppUser(fx, A, stmt, [A])]).toEqual([stmt, '42501']);
    // Records name their POP with the POP's company: Z's session cannot claim A's POP.
    const popA = await seedPop(fx, A, { beneficiary: 'Claim Check', date: '2026-11-12' });
    const claim = "INSERT INTO pop_archive_copies (company_id, proof_of_payment_id, outcome, path) VALUES ($1, $2, 'too_large', 'x')";
    expect(await asAppUser(fx, Z, claim, [Z, popA.popId])).toBe('23503');
    expect(await asAppUser(fx, A, claim, [A, popA.popId])).toBe('ok:1');
    const attempt = "INSERT INTO pop_archive_attempts (company_id, proof_of_payment_id, attempts, last_error) VALUES ($1, $2, 1, 'x')";
    expect(await asAppUser(fx, Z, attempt, [Z, popA.popId])).toBe('23503');
    expect(await asAppUser(fx, A, attempt, [A, popA.popId])).toBe('ok:1');
  });
});
