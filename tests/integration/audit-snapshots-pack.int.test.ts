/**
 * Forensic-controls step 4 — the audit pack built from a snapshot:
 *  - owner builds a pack (a new snapshot, or a chosen one): a ZIP whose
 *    manifest cites the snapshot's canonical hash and HMAC and every file's
 *    SHA-256; CSV cells are formula-neutralised; the PDF is inside;
 *  - the auditor portal session downloads the same ZIP;
 *  - pack verify is valid, and invalid once a stored snapshot row is altered;
 *  - a manager cannot build one; older PDF-only packs still download as PDF;
 *  - a pack is ready only once built, a ready one is kept, and a ZIP that does not verify is never served.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import JSZip from 'jszip';
import auditExports from '../../pages/api/accounting/audit-exports/index';
import auditExport from '../../pages/api/accounting/audit-exports/[id]/index';
import exportDownload from '../../pages/api/accounting/audit-exports/[id]/download';
import exportSessions from '../../pages/api/accounting/audit-exports/[id]/sessions';
import portalDownload from '../../pages/api/audit-portal/download';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { as, members, newCompany } from './entity-changes.helpers';
import { cleanupAudit, plantJournal, plantLedger } from './audit-snapshots.helpers';
import { startFakeStorage, type FakeStorage } from './audit-snapshots-storage.helpers';
import { sha256Hex } from '../../src/modules/accounting/services/audit/canonical';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let o = '', m = '', v = '';
let storage: FakeStorage;

beforeAll(async () => {
  [o, m, v] = await members(pool, tokens, 3);
  process.env.AUDIT_SNAPSHOT_SIGNING_KEY = 'p'.repeat(48);
  process.env.AUDIT_SNAPSHOT_KEY_ID = 'pack-test';
  storage = await startFakeStorage();
  process.env.SUPABASE_URL = storage.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
});
afterAll(async () => { await storage.close(); await cleanupAudit(pool, companies, [o, m, v]); });

interface Export { id: string; status: string; snapshotId: string; zipSha256: string; periodEnd: string; error: string | null }

async function company() {
  const c = await newCompany(pool, [[o, 'owner'], [m, 'manager'], [v, 'viewer']], companies);
  const l = await plantLedger(pool, c);
  await plantJournal(pool, c, { date: '2026-03-10', amount: 1000, debit: l.bank, credit: l.sales, by: o, description: '=HYPERLINK("http://x")' });
  await plantJournal(pool, c, { date: '2026-02-01', amount: 40, debit: l.expense, credit: l.bank, by: o });
  return c;
}
const build = (user: string, c: string, body: Record<string, unknown>) =>
  callRoute(auditExports, tokens[user]!, c, 'POST', body, '/api/accounting/audit-exports');
const bytesOf = (r: { state: { body: unknown } }) => r.state.body as Buffer;

/** The owner disabling the pack guard to re-point a ready pack's hash (what injected SQL after RESET ROLE could do). */
async function ownerRepoint(id: string, sha: string) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('ALTER TABLE audit_trail_exports DISABLE TRIGGER audit_trail_export_pack_guard');
    await db.query('UPDATE audit_trail_exports SET zip_sha256 = $2 WHERE id = $1', [id, sha]);
    await db.query('ALTER TABLE audit_trail_exports ENABLE ALWAYS TRIGGER audit_trail_export_pack_guard');
    await db.query('COMMIT');
  } finally { db.release(); }
}

/** The test response with `send` (the download routes send bytes, not JSON). */
function sendable() {
  const r = response();
  (r.res as unknown as { send: (b: unknown) => unknown }).send = (b: unknown) => { r.state.body = b; return r.state; };
  return r;
}
async function download(user: string, c: string, id: string) {
  const req = request({ 'sb-access-token': tokens[user]!, active_company_id: c }, 'GET') as never as { query: Record<string, string>; url: string };
  req.query = { id };
  req.url = `/api/accounting/audit-exports/${id}/download`;
  const r = sendable();
  await exportDownload(req as never, r.res as never);
  return r;
}

describe('audit pack from a snapshot', { timeout: 120_000 }, () => {
  it('builds a ZIP whose manifest cites the snapshot hash and every file, CSVs neutralised, PDF inside', async () => {
    const c = await company();
    const res = await build(o, c, { periodStart: '2026-03-01', periodEnd: '2026-06-30', includeComparison: true });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
    const ex = dataOf<{ export: Export }>(res).export;
    expect([ex.status, ex.periodEnd]).toEqual(['ready', '2026-06-30']);
    const dl = await download(o, c, ex.id);
    expect(dl.state.statusCode).toBe(200);
    const zipBytes = bytesOf(dl);
    expect(sha256Hex(zipBytes)).toBe(ex.zipSha256);
    const zip = await JSZip.loadAsync(zipBytes);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    const { rows: [s] } = await pool.query('SELECT canonical_hash, hmac, key_id FROM audit_snapshots WHERE id = $1', [ex.snapshotId]);
    expect(manifest.snapshot).toMatchObject({ id: ex.snapshotId, canonical_hash: s.canonical_hash, hmac: s.hmac, key_id: 'pack-test',
      verified_at_build: 'valid' });
    expect(manifest.files.map((f: { name: string }) => f.name).sort()).toEqual(['audit-pack.pdf', 'checks.csv', 'comparison.csv',
      'findings.csv', 'journal_lines.csv', 'journals.csv', 'trial_balance.csv']);
    for (const f of manifest.files) expect(sha256Hex(await zip.file(f.name)!.async('nodebuffer')), f.name).toBe(f.sha256);
    const journals = await zip.file('journals.csv')!.async('string');
    expect(journals).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(journals).not.toMatch(/"=HYPERLINK/);
    expect(await zip.file('trial_balance.csv')!.async('string')).toContain('"-1000.00"');
    expect((await zip.file('audit-pack.pdf')!.async('nodebuffer')).subarray(0, 5).toString()).toBe('%PDF-');
    const ver = dataOf<{ verification: { status: string } }>(await callRoute(auditExport, tokens[o]!, c, 'GET', undefined, '/x', { id: ex.id, verify: '1' }));
    expect(ver.verification.status).toBe('valid');
  });

  it('the auditor portal downloads the same ZIP', async () => {
    const c = await company();
    const ex = dataOf<{ export: Export }>(await build(o, c, { periodStart: '2026-01-01', periodEnd: '2026-06-30' })).export;
    const session = dataOf<{ session: { id: string }; accessToken: string }>(await callRoute(exportSessions, tokens[o]!, c, 'POST',
      { auditorEmail: 'auditor@example.test' }, '/x', { id: ex.id }));
    const res = sendable();
    await portalDownload({ method: 'GET', query: { sessionId: session.session.id, token: session.accessToken }, headers: {} } as never, res.res as never);
    expect(res.state.statusCode).toBe(200);
    expect(sha256Hex(res.state.body as Buffer)).toBe(ex.zipSha256);
    // Each download verifies the whole ZIP: ten a minute per auditor session (blind r3 L3).
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = sendable();
      await portalDownload({ method: 'GET', query: { sessionId: session.session.id, token: session.accessToken }, headers: {} } as never, r.res as never);
      statuses.push(r.state.statusCode);
    }
    expect(statuses).toEqual([...Array(9).fill(200), 429]);
  });

  it('builds from a chosen snapshot; verify turns invalid once a stored snapshot row is altered', async () => {
    const c = await company();
    const first = dataOf<{ export: Export }>(await build(o, c, { periodStart: '2026-01-01', periodEnd: '2026-06-30' })).export;
    const again = dataOf<{ export: Export }>(await build(o, c, { periodStart: '2026-03-01', snapshotId: first.snapshotId })).export;
    expect([again.snapshotId, again.periodEnd]).toEqual([first.snapshotId, '2026-06-30']);
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('ALTER TABLE audit_snapshot_journals DISABLE TRIGGER audit_snapshot_journals_append_only');
      await db.query(`UPDATE audit_snapshot_journals SET row = jsonb_set(row, '{description}', '"tampered"') WHERE snapshot_id = $1`, [first.snapshotId]);
      await db.query('ALTER TABLE audit_snapshot_journals ENABLE ALWAYS TRIGGER audit_snapshot_journals_append_only');
      await db.query('COMMIT');
    } finally { db.release(); }
    const ver = dataOf<{ verification: { status: string; snapshotStatus: string } }>(
      await callRoute(auditExport, tokens[o]!, c, 'GET', undefined, '/x', { id: again.id, verify: '1' }));
    expect(ver.verification).toMatchObject({ status: 'invalid', snapshotStatus: 'invalid' });
    const refused = await build(o, c, { periodStart: '2026-03-01', snapshotId: first.snapshotId });
    expect(refused.state.statusCode).toBe(400);
  });

  it('a manager cannot build a pack (but downloads one), a viewer cannot download one; a pack cannot end anywhere but its snapshot\'s cutoff', async () => {
    const c = await company();
    expect((await build(m, c, { periodStart: '2026-01-01', periodEnd: '2026-06-30' })).state.statusCode).toBe(403);
    const ex = dataOf<{ export: Export }>(await build(o, c, { periodStart: '2026-01-01', periodEnd: '2026-06-30' })).export;
    expect((await build(o, c, { periodStart: '2026-01-01', periodEnd: '2026-05-31', snapshotId: ex.snapshotId })).state.statusCode).toBe(400);
    // A viewer may not list packs either (L7), nor build one with an impossible date.
    expect((await callRoute(auditExports, tokens[v]!, c, 'GET', undefined, '/api/accounting/audit-exports')).state.statusCode).toBe(403);
    expect((await build(o, c, { periodStart: '2026-02-30', periodEnd: '2026-06-30' })).state.statusCode).toBe(422);
    // The ZIP carries the snapshot's ledger rows: a viewer may not download it; a manager may.
    expect((await download(v, c, ex.id)).state.statusCode).toBe(403);
    expect((await download(m, c, ex.id)).state.statusCode).toBe(200);
    // Nor read a pack's metadata or its auditor sessions; only owner / admin hand a pack to an outsider.
    expect((await callRoute(auditExport, tokens[v]!, c, 'GET', undefined, '/x', { id: ex.id })).state.statusCode).toBe(403);
    expect((await callRoute(exportSessions, tokens[v]!, c, 'GET', undefined, '/x', { id: ex.id })).state.statusCode).toBe(403);
    expect((await callRoute(exportSessions, tokens[m]!, c, 'POST', { auditorEmail: 'a@example.test' }, '/x', { id: ex.id })).state.statusCode).toBe(403);
    expect((await callRoute(exportSessions, tokens[m]!, c, 'GET', undefined, '/x', { id: ex.id })).state.statusCode).toBe(200);
  });

  it('the manifest is sealed: an edited CSV with a recomputed manifest and zip hash is invalid; a ZIP without a manifest is invalid, not a crash', async () => {
    const c = await company();
    const ex = dataOf<{ export: Export }>(await build(o, c, { periodStart: '2026-01-01', periodEnd: '2026-06-30' })).export;
    const key = `captured-documents/${c}/audit-${ex.id}.zip`;
    const zip = await JSZip.loadAsync(storage.files.get(key)!);
    expect(zip.file('manifest.sig.json')).toBeTruthy();
    // Forge: change a CSV, rebuild the manifest's file hashes, store the ZIP and its hash — everything but the key.
    zip.file('journals.csv', '"journal_id"\r\n"forged"\r\n');
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    for (const f of manifest.files) f.sha256 = sha256Hex(await zip.file(f.name)!.async('nodebuffer'));
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    const forged = await zip.generateAsync({ type: 'nodebuffer' });
    storage.files.set(key, forged);
    // A ready pack's pointers are fixed: the UPDATE is refused, even for the table owner's plain statement ...
    expect(await pool.query('UPDATE audit_trail_exports SET zip_sha256 = $2 WHERE id = $1', [ex.id, sha256Hex(forged)])
      .then(() => 'ok', (e: { code?: string }) => e.code)).toBe('42501');
    // ... so the forger disables the guard as the owner — and the manifest seal still refuses it.
    await ownerRepoint(ex.id, sha256Hex(forged));
    const verify = () => callRoute(auditExport, tokens[o]!, c, 'GET', undefined, '/x', { id: ex.id, verify: '1' });
    expect(dataOf<{ verification: { status: string; manifestSeal: string; zipMatches: boolean } }>(await verify()).verification)
      .toMatchObject({ status: 'invalid', manifestSeal: 'invalid', zipMatches: true });
    const bare = new JSZip();
    bare.file('journals.csv', 'x');
    const bareBytes = await bare.generateAsync({ type: 'nodebuffer' });
    storage.files.set(key, bareBytes);
    await ownerRepoint(ex.id, sha256Hex(bareBytes));
    const r = await verify();
    expect(r.state.statusCode).toBe(200);
    expect(dataOf<{ verification: { status: string; manifestSeal: string } }>(r).verification).toMatchObject({ status: 'invalid', manifestSeal: 'missing' });
    // A manifest that is not JSON, or JSON of the wrong shape: invalid too, not a 500 (blind r2 L4).
    for (const text of ['{not json', JSON.stringify({ files: 'x' })]) {
      const bad = new JSZip();
      bad.file('manifest.json', text);
      bad.file('manifest.sig.json', JSON.stringify({ hmac: 'a'.repeat(64), key_id: 'k' }));
      const badBytes = await bad.generateAsync({ type: 'nodebuffer' });
      storage.files.set(key, badBytes);
      await ownerRepoint(ex.id, sha256Hex(badBytes));
      const res = await verify();
      expect(res.state.statusCode).toBe(200);
      expect(dataOf<{ verification: { status: string; manifestSeal: string } }>(res).verification)
        .toMatchObject({ status: 'invalid', manifestSeal: 'missing' });
    }
  });

  it('nothing is inflated past its size, a file the manifest does not list fails it, and a retired key is judged by built_at', async () => {
    const c = await company();
    const ex = dataOf<{ export: Export }>(await build(o, c, { periodStart: '2026-01-01', periodEnd: '2026-06-30' })).export;
    const key = `captured-documents/${c}/audit-${ex.id}.zip`;
    const genuine = storage.files.get(key)!;
    const verify = async () => dataOf<{ verification: { status: string; manifestSeal: string; files: { name: string; ok: boolean }[] } }>(
      await callRoute(auditExport, tokens[o]!, c, 'GET', undefined, '/x', { id: ex.id, verify: '1' })).verification;
    const store = async (bytes: Buffer) => { storage.files.set(key, bytes); await ownerRepoint(ex.id, sha256Hex(bytes)); };
    // A well-formed manifest padded past 1 MiB is not read at all (missing), not inflated and then refused (invalid).
    const padded = await JSZip.loadAsync(genuine);
    padded.file('manifest.json', `${' '.repeat(2 * 1024 * 1024)}${await padded.file('manifest.json')!.async('string')}`);
    await store(await padded.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    expect(await verify()).toMatchObject({ status: 'invalid', manifestSeal: 'missing' });
    // The genuine ZIP plus a file the manifest does not list: the seal holds, the extra file fails the pack.
    const extra = await JSZip.loadAsync(genuine);
    extra.file('extra.csv', '=cmd');
    await store(await extra.generateAsync({ type: 'nodebuffer' }));
    const v = await verify();
    expect(v).toMatchObject({ status: 'invalid', manifestSeal: 'valid' });
    expect(v.files).toContainEqual({ name: 'extra.csv', ok: false });
    await store(genuine);
    expect((await verify()).status).toBe('valid');
    // A later pack from the same snapshot: its manifest's taken_at (the snapshot's) predates its built_at.
    await new Promise((r) => setTimeout(r, 50));
    const later = dataOf<{ export: Export }>(await build(o, c, { periodStart: '2026-01-01', snapshotId: ex.snapshotId })).export;
    const verifyLater = async () => dataOf<{ verification: { manifestSeal: string } }>(
      await callRoute(auditExport, tokens[o]!, c, 'GET', undefined, '/x', { id: later.id, verify: '1' })).verification;
    const { rows: [t] } = await pool.query(
      'SELECT s.taken_at, e.built_at FROM audit_trail_exports e JOIN audit_snapshots s ON s.id = e.snapshot_id WHERE e.id = $1', [later.id]);
    expect(t.taken_at.getTime()).toBeLessThan(t.built_at.getTime());
    const rotate = (retiredAt: Date) => Object.assign(process.env, { AUDIT_SNAPSHOT_KEY_ID: 'pack-test-2',
      AUDIT_SNAPSHOT_SIGNING_KEY: 'q'.repeat(48), AUDIT_SNAPSHOT_RETIRED_KEYS: `pack-test=${'p'.repeat(48)}@${retiredAt.toISOString()}` });
    try {
      // Rotated away from the pack's key after it was built: still valid.
      rotate(new Date(t.built_at.getTime() + 3_600_000));
      expect((await verifyLater()).manifestSeal).toBe('valid');
      // Retired after the snapshot was taken but before the pack was built: the manifest's own time would pass it;
      // the database's built_at does not.
      rotate(new Date(t.built_at.getTime() - 1));
      expect(t.taken_at.getTime()).toBeLessThan(t.built_at.getTime() - 1);
      expect((await verifyLater()).manifestSeal).toBe('invalid');
    } finally {
      Object.assign(process.env, { AUDIT_SNAPSHOT_KEY_ID: 'pack-test', AUDIT_SNAPSHOT_SIGNING_KEY: 'p'.repeat(48), AUDIT_SNAPSHOT_RETIRED_KEYS: '' });
    }
  });

  it('an older PDF-only pack (built before 890) still downloads as its PDF', async () => {
    const c = await company();
    storage.files.set(`captured-documents/${c}/legacy.pdf`, Buffer.from('%PDF-legacy'));
    // Such rows exist from before the guard; one can no longer be made ready without a snapshot and its ZIP.
    const db = await pool.connect();
    let id = '';
    try {
      await db.query('BEGIN');
      await db.query('ALTER TABLE audit_trail_exports DISABLE TRIGGER audit_trail_export_pack_guard');
      id = (await db.query(
        `INSERT INTO audit_trail_exports(company_id, period_start, period_end, status, pdf_storage_bucket, pdf_storage_path, pdf_sha256)
         VALUES($1, '2026-01-01', '2026-03-31', 'ready', 'captured-documents', $2, 'abc') RETURNING id`, [c, `${c}/legacy.pdf`])).rows[0].id;
      await db.query('ALTER TABLE audit_trail_exports ENABLE ALWAYS TRIGGER audit_trail_export_pack_guard');
      await db.query('COMMIT');
    } finally { db.release(); }
    const dl = await download(o, c, id);
    expect([dl.state.statusCode, bytesOf(dl).toString()]).toEqual([200, '%PDF-legacy']);
  });

  it('a pack is ready only once built, a ready pack is kept, and a forged ZIP made ready is never served (breaker r2 N1)', async () => {
    const c = await company();
    const genuine = dataOf<{ export: Export }>(await build(o, c, { periodStart: '2026-01-01', periodEnd: '2026-06-30' })).export;
    const asManager = <T>(fn: (db: import('pg').PoolClient) => Promise<T>) => as(pool, m, { company: c }, fn);
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);
    // As app_user with a manager's claims: an INSERTed ready row and a DELETEd ready pack are refused.
    expect(await code(asManager((db) => db.query(
      `INSERT INTO audit_trail_exports(company_id, period_start, period_end, status, snapshot_id, zip_storage_path, zip_sha256)
       VALUES($1, '2026-01-01', '2026-06-30', 'ready', $2, 'p', 'h')`, [c, genuine.snapshotId])))).toBe('42501');
    expect(await code(asManager((db) => db.query('DELETE FROM audit_trail_exports WHERE id = $1', [genuine.id])))).toBe('42501');
    expect(await code(asManager((db) => db.query(
      `UPDATE audit_trail_exports SET pdf_storage_bucket = 'elsewhere' WHERE id = $1`, [genuine.id])))).toBe('42501');
    expect(await code(asManager((db) => db.query(
      `UPDATE audit_trail_exports SET built_at = now() - interval '1 year' WHERE id = $1`, [genuine.id])))).toBe('42501');
    // A failed export moved to ready without a snapshot and ZIP: refused.
    const failed = (await asManager((db) => db.query(
      `INSERT INTO audit_trail_exports(company_id, period_start, period_end, status) VALUES($1, '2026-01-01', '2026-06-30', 'failed')
       RETURNING id`, [c]))).rows[0].id as string;
    expect(await code(asManager((db) => db.query(
      `UPDATE audit_trail_exports SET status = 'ready', pdf_storage_bucket = 'captured-documents', pdf_storage_path = 'x', pdf_sha256 = 'y'
       WHERE id = $1`, [failed])))).toBe('42501');
    // With the genuine snapshot and a forged ZIP (an edited CSV, the manifest's hashes recomputed) the database lets it
    // through — it cannot check an HMAC — but neither download serves it.
    const zip = await JSZip.loadAsync(storage.files.get(`captured-documents/${c}/audit-${genuine.id}.zip`)!);
    zip.file('journals.csv', '"journal_id"\r\n"forged"\r\n');
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    for (const f of manifest.files) f.sha256 = sha256Hex(await zip.file(f.name)!.async('nodebuffer'));
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    const forged = await zip.generateAsync({ type: 'nodebuffer' });
    storage.files.set(`captured-documents/${c}/forged.zip`, forged);
    expect(await code(asManager((db) => db.query(
      `UPDATE audit_trail_exports SET status = 'ready', snapshot_id = $2, zip_storage_bucket = 'captured-documents',
         zip_storage_path = $3, zip_sha256 = $4, built_at = '2020-01-01' WHERE id = $1`, [failed, genuine.snapshotId, `${c}/forged.zip`, sha256Hex(forged)])))).toBe('ok');
    // Its built_at is the database's clock at the move, whatever the forger wrote: a key retired before then fails it.
    const { rows: [stamp] } = await pool.query("SELECT built_at > now() - interval '1 minute' AS fresh FROM audit_trail_exports WHERE id = $1", [failed]);
    expect(stamp.fresh).toBe(true);
    const dl = await download(o, c, failed);
    expect([dl.state.statusCode, (dl.state.body as { error?: { details?: { reason?: string } } }).error?.details?.reason]).toEqual([400, 'PACK_REFUSED']);
    const session = dataOf<{ session: { id: string }; accessToken: string }>(await callRoute(exportSessions, tokens[o]!, c, 'POST',
      { auditorEmail: 'auditor@example.test' }, '/x', { id: failed }));
    const portal = sendable();
    await portalDownload({ method: 'GET', query: { sessionId: session.session.id, token: session.accessToken }, headers: {} } as never, portal.res as never);
    expect(portal.state.statusCode).toBe(400);
    expect(Buffer.isBuffer(portal.state.body)).toBe(false);
    // The genuine pack still downloads.
    expect((await download(o, c, genuine.id)).state.statusCode).toBe(200);
  });
});
