/**
 * Forensic-controls step 4 — the audit pack built from a snapshot:
 *  - owner builds a pack (a new snapshot, or a chosen one): a ZIP whose
 *    manifest cites the snapshot's canonical hash and HMAC and every file's
 *    SHA-256; CSV cells are formula-neutralised; the PDF is inside;
 *  - the auditor portal session downloads the same ZIP;
 *  - pack verify is valid, and invalid once a stored snapshot row is altered;
 *  - a manager cannot build one; older PDF-only packs still download as PDF.
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
import { members, newCompany } from './entity-changes.helpers';
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
    await pool.query('UPDATE audit_trail_exports SET zip_sha256 = $2 WHERE id = $1', [ex.id, sha256Hex(forged)]);
    const verify = () => callRoute(auditExport, tokens[o]!, c, 'GET', undefined, '/x', { id: ex.id, verify: '1' });
    expect(dataOf<{ verification: { status: string; manifestSeal: string; zipMatches: boolean } }>(await verify()).verification)
      .toMatchObject({ status: 'invalid', manifestSeal: 'invalid', zipMatches: true });
    const bare = new JSZip();
    bare.file('journals.csv', 'x');
    const bareBytes = await bare.generateAsync({ type: 'nodebuffer' });
    storage.files.set(key, bareBytes);
    await pool.query('UPDATE audit_trail_exports SET zip_sha256 = $2 WHERE id = $1', [ex.id, sha256Hex(bareBytes)]);
    const r = await verify();
    expect(r.state.statusCode).toBe(200);
    expect(dataOf<{ verification: { status: string; manifestSeal: string } }>(r).verification).toMatchObject({ status: 'invalid', manifestSeal: 'missing' });
  });

  it('an older PDF-only pack still downloads as its PDF', async () => {
    const c = await company();
    storage.files.set(`captured-documents/${c}/legacy.pdf`, Buffer.from('%PDF-legacy'));
    const { rows: [e] } = await pool.query(
      `INSERT INTO audit_trail_exports(company_id, period_start, period_end, status, pdf_storage_bucket, pdf_storage_path, pdf_sha256)
       VALUES($1, '2026-01-01', '2026-03-31', 'ready', 'captured-documents', $2, 'abc') RETURNING id`, [c, `${c}/legacy.pdf`]);
    const dl = await download(o, c, e.id);
    expect([dl.state.statusCode, bytesOf(dl).toString()]).toEqual([200, '%PDF-legacy']);
  });
});
