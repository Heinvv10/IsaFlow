/**
 * PR #1559 review findings against real Postgres (999q), every tool call as app_user:
 *  - dedup is by sha256 only: a DIFFERENT file with the same name and size is stored, at create and at finalize;
 *  - two finalizes of the same bytes to one line, concurrently, store it once (advisory lock before the dedup read);
 *  - a polyglot body (right magic, wrong ending) is refused at the PUT;
 *  - per-company caps on outstanding uploads (count and declared bytes);
 *  - the global sweep: an expired row anywhere loses its bytes but keeps its row (reads 'expired'), and is deleted a
 *    week later; a PUT extends the finalize window to 2 hours;
 *  - app_user cannot forge status / result / created_by / staged bytes; app_service can stage and sweep;
 *  - audit rows for a PUT, a refusal and a duplicate finalize.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { stageUploadBytes } from '@/modules/accounting/services/core/mcpUploadIntentStore';
import { SWEEP_MIN_INTERVAL_MS } from '@/modules/accounting/services/core/mcpUploadIntentSweep';
import { sweepExpiredUploads } from '@/modules/accounting/services/core/mcpUploadIntentSweep';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, runOn, seedBankTx, seedBill, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { dropDocuments } from './helpers/documentFixture';
import { inAppUserTx } from './helpers/appUserTx';
import {
  JPG, PDF, PNG, attachmentsOn, bankFile, createUrls, dropUploads, finalize, put, seedMember, sha, type Json,
} from './helpers/mcpUploadHarness';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('MCP uploads: review hardening (999q)', () => {
  let fx: Fixture; let other: Fixture; let capped: Fixture;
  let lines: string[]; let otherLine: string; let otherBill: string;
  const first = (r: Json) => (r.uploads as Json[])[0]!;

  beforeAll(async () => {
    assertNotProductionDb('This test seeds companies, bank lines, uploads and attachments.');
    fx = await seedFixture('UPLH', DATABASE_URL!);
    other = await seedFixture('UPLHB', DATABASE_URL!);
    capped = await seedFixture('UPLHC', DATABASE_URL!);
    for (const f of [fx, other, capped]) await seedMember(f);
    lines = [];
    for (let i = 0; i < 8; i += 1) lines.push(await seedBankTx(fx, { date: '2026-11-0' + (i + 1), amount: -100 - i, description: `h ${i}` }));
    otherLine = await seedBankTx(other, { date: '2026-11-01', amount: -50, description: 'theirs' });
    otherBill = await seedBill(other, { number: 'B1', date: '2026-11-01', total: 100 });
  }, 120000);

  afterAll(async () => {
    for (const f of [fx, other, capped]) {
      if (!f) continue;
      await dropDocuments(f);
      await dropUploads(f);
      await dropFixture(f);
      await sql`DELETE FROM users WHERE id = ${f.userId}`;
    }
  }, 120000);

  it('stores a different file with the same name and size (create after a finalize)', async () => {
    const a = PDF('amount 1000.00'); const b = PDF('amount 9000.00');
    expect(a.length).toBe(b.length);
    const u1 = first(await createUrls(fx, [bankFile(lines[0]!, 'inv.pdf', a)]));
    expect(await put(String(u1.url), a)).toBe(200);
    expect(((await finalize(fx, [u1.upload_id])).files as Json[])[0]).toMatchObject({ status: 'finalized' });
    const u2 = first(await createUrls(fx, [bankFile(lines[0]!, 'inv.pdf', b)]));
    expect(u2).toMatchObject({ status: 'url_issued' });
    expect(await put(String(u2.url), b)).toBe(200);
    const done = await finalize(fx, [u2.upload_id]);
    expect((done.files as Json[])[0]).toMatchObject({ status: 'finalized', duplicate: false });
    expect(await attachmentsOn(lines[0]!)).toBe(2);
  });

  it('stores both of two different same-name same-size files finalized in one call', async () => {
    const a = PDF('amount 2000.00'); const b = PDF('amount 8000.00');
    const c = await createUrls(fx, [bankFile(lines[1]!, 'inv.pdf', a), bankFile(lines[1]!, 'inv.pdf', b)]);
    const us = c.uploads as Json[];
    expect(await put(String(us[0]!.url), a)).toBe(200);
    expect(await put(String(us[1]!.url), b)).toBe(200);
    const done = await finalize(fx, us.map((u) => u.upload_id));
    expect((done.files as Json[]).map((f) => f.duplicate)).toEqual([false, false]);
    expect(await attachmentsOn(lines[1]!)).toBe(2);
  });

  it('stores the same bytes once when two finalizes race', async () => {
    for (let t = 0; t < 5; t += 1) {
      const line = lines[2]!; const a = PDF(`race ${t}`);
      const before = await attachmentsOn(line);
      const u1 = first(await createUrls(fx, [bankFile(line, `r${t}a.pdf`, a)]));
      const u2 = first(await createUrls(fx, [bankFile(line, `r${t}b.pdf`, a)]));
      expect(await put(String(u1.url), a)).toBe(200);
      expect(await put(String(u2.url), a)).toBe(200);
      const [f1, f2] = await Promise.all([finalize(fx, [u1.upload_id]), finalize(fx, [u2.upload_id])]);
      const results = [(f1.files as Json[])[0]!, (f2.files as Json[])[0]!];
      expect(await attachmentsOn(line) - before).toBe(1);
      expect(results[0]!.document_id).toBe(results[1]!.document_id);
      expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
    }
  });

  it('refuses a polyglot body at the PUT: right magic bytes, wrong ending', async () => {
    const poly = Buffer.from('%PDF-1.4\n<html><script>alert(1)</script></html>\n');
    const png = PNG('x').subarray(0, PNG('x').length - 12);
    const jpg = Buffer.concat([JPG('y').subarray(0, JPG('y').length - 2), Buffer.from('<html>')]);
    const c = await createUrls(fx, [bankFile(lines[3]!, 'p.pdf', poly), bankFile(lines[3]!, 'p.png', png, 'image/png'),
      bankFile(lines[3]!, 'p.jpg', jpg, 'image/jpeg')]);
    const us = c.uploads as Json[];
    expect(await put(String(us[0]!.url), poly)).toBe(400);
    expect(await put(String(us[1]!.url), png)).toBe(400);
    expect(await put(String(us[2]!.url), jpg)).toBe(400);
    const rows = await sql`SELECT status FROM mcp_upload_intents WHERE id = ANY(${us.map((u) => String(u.upload_id))}::UUID[])`;
    expect(rows.map((r) => r.status)).toEqual(['pending', 'pending', 'pending']);
  });

  it('refuses a forged or tampered url at the PUT (404) and leaves the real one usable', async () => {
    const a = PDF('mac');
    const u = first(await createUrls(fx, [bankFile(lines[3]!, 'mac.pdf', a)]));
    const url = String(u.url);
    const token = url.split('/').pop()!;
    const tampered = token.slice(0, 5) + (token[5] === 'A' ? 'B' : 'A') + token.slice(6);
    expect(await put(url.replace(token, tampered), a)).toBe(404);
    expect(await put(url.replace(token, randomBytes(32).toString('base64url')), a)).toBe(404);
    expect((await sql`SELECT status FROM mcp_upload_intents WHERE id = ${String(u.upload_id)}::UUID`)[0]!.status).toBe('pending');
    expect(await put(url, a)).toBe(200);
  });

  it('hashes only same-size attachments: same bytes under another stored size are not a duplicate', async () => {
    const a = PDF('sized');
    const url = `data:application/pdf;base64,${a.toString('base64')}`;
    await sql`INSERT INTO bank_transaction_attachments (bank_transaction_id, file_url, file_name, file_size)
      VALUES (${lines[4]!}::UUID, ${url}, 'x.pdf', ${a.length + 1})`;
    expect(first(await createUrls(fx, [bankFile(lines[4]!, 'x.pdf', a)]))).toMatchObject({ status: 'url_issued' });
    await sql`UPDATE bank_transaction_attachments SET file_size = ${a.length} WHERE bank_transaction_id = ${lines[4]!}::UUID`;
    expect(first(await createUrls(fx, [bankFile(lines[4]!, 'y.pdf', a)]))).toMatchObject({ status: 'duplicate' });
  });

  it('caps a company\'s outstanding uploads by count and by declared bytes, per file', async () => {
    const line = await seedBankTx(capped, { date: '2026-11-01', amount: -1, description: 'cap' });
    const fileN = (n: number) => bankFile(line, `m${n}.pdf`, PDF(`cap ${n}`));
    for (let call = 0; call < 3; call += 1) {
      const r = await createUrls(capped, Array.from({ length: 100 }, (_, j) => fileN(call * 100 + j)));
      expect(r.urls_issued).toBe(100);
    }
    const over = await createUrls(capped, [fileN(300)]);
    expect(first(over)).toMatchObject({ status: 'refused' });
    expect(String(first(over).error)).toMatch(/300 uploads outstanding/);

    const ten = 10 * 1024 * 1024;
    const big = (n: number) => ({ target: { entity_type: 'supplier_invoice', entity_id: otherBill }, file_name: `b${n}.pdf`,
      mime_type: 'application/pdf', size: ten, sha256: sha(Buffer.from(`big ${n}`)) });
    const r = await createUrls(other, Array.from({ length: 31 }, (_, n) => big(n)));
    expect(r.urls_issued).toBe(30);
    expect((r.uploads as Json[])[30]).toMatchObject({ status: 'refused' });
    expect(String((r.uploads as Json[])[30]!.error)).toMatch(/300 MB/);
    await sql`DELETE FROM mcp_upload_intents WHERE company_id = ${other.companyId}::UUID`;
  }, 120000);

  it('extends an uploaded row to a 2-hour finalize window; sweeps expired bytes in every company, rows kept a week', async () => {
    const a = PDF('sweep');
    const u = first(await createUrls(other, [bankFile(otherLine, 's.pdf', a)]));
    expect(await put(String(u.url), a)).toBe(200);
    const [w] = await sql`SELECT expires_at > now() + interval '110 minutes' AS long FROM mcp_upload_intents WHERE id = ${String(u.upload_id)}::UUID`;
    expect(w!.long).toBe(true);

    // The sweep runs at most once per SWEEP_MIN_INTERVAL_MS per process: move this process's clock past that window
    // before each triggering call (only Date is faked; timers and the database clock are real).
    const pastThrottle = () => vi.setSystemTime(Date.now() + SWEEP_MIN_INTERVAL_MS + 1);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
    await sql`UPDATE mcp_upload_intents SET expires_at = now() - interval '1 minute' WHERE id = ${String(u.upload_id)}::UUID`;
    pastThrottle();
    await createUrls(fx, [bankFile(lines[5]!, 'trigger.pdf', PDF('sweep trigger'))]); // a tool call in ANOTHER company
    const [row] = await sql`SELECT staged_bytes IS NULL AS cleared FROM mcp_upload_intents WHERE id = ${String(u.upload_id)}::UUID`;
    expect(row!.cleared).toBe(true);
    expect((await finalize(other, [u.upload_id])).files).toEqual([expect.objectContaining({ status: 'expired' })]);

    await sql`UPDATE mcp_upload_intents SET expires_at = now() - interval '8 days' WHERE id = ${String(u.upload_id)}::UUID`;
    pastThrottle();
    await createUrls(fx, [bankFile(lines[5]!, 'trigger2.pdf', PDF('sweep trigger 2'))]);
    expect(await sql`SELECT 1 FROM mcp_upload_intents WHERE id = ${String(u.upload_id)}::UUID`).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('app_user cannot forge status, result, created_by, bytes or expiry, nor delete', async () => {
    const a = PDF('forge');
    const u = first(await createUrls(fx, [bankFile(lines[6]!, 'f.pdf', a)]));
    const id = String(u.upload_id);
    const [stamped] = await sql`SELECT created_by FROM mcp_upload_intents WHERE id = ${id}::UUID`;
    expect(stamped!.created_by).toBe(fx.userId);
    // Awaited INSIDE the app_user context: a bare sql`` is lazy, and awaiting it outside runs it on the default pool.
    const asApp = (q: () => PromiseLike<unknown>) => inAppUserTx(fx, async () => { await q(); });
    await expect(asApp(() => sql`UPDATE mcp_upload_intents SET staged_bytes = ${a} WHERE id = ${id}::UUID`)).rejects.toThrow(/permission denied/);
    await expect(asApp(() => sql`UPDATE mcp_upload_intents SET expires_at = now() + interval '1 day' WHERE id = ${id}::UUID`)).rejects.toThrow(/permission denied/);
    await expect(asApp(() => sql`UPDATE mcp_upload_intents SET file_name = 'x' WHERE id = ${id}::UUID`)).rejects.toThrow(/permission denied/);
    await expect(asApp(() => sql`DELETE FROM mcp_upload_intents WHERE id = ${id}::UUID`)).rejects.toThrow(/permission denied/);
    await expect(asApp(() => sql`INSERT INTO mcp_upload_intents (company_id, created_by, target_kind, target_id, file_name,
      mime_type, declared_size, sha256, token_hash) VALUES (${fx.companyId}::UUID, ${other.userId}, 'bank_transaction',
      ${lines[6]!}::UUID, 'x.pdf', 'application/pdf', 1, ${sha(a)}, ${sha(Buffer.from(randomUUID()))})`)).rejects.toThrow(/permission denied/);
    // Pending → finalized with a made-up document: refused by the guard.
    await expect(asApp(() => sql`UPDATE mcp_upload_intents SET status = 'finalized', result_document_id = ${randomUUID()}::UUID
      WHERE id = ${id}::UUID`)).rejects.toThrow(/upload intent/);
    expect(await put(String(u.url), a)).toBe(200);
    // Uploaded → finalized naming a document that is not the line's same bytes: refused.
    const decoy = (await sql`INSERT INTO bank_transaction_attachments (bank_transaction_id, file_url, file_name, file_size)
      VALUES (${lines[6]!}::UUID, ${`data:application/pdf;base64,${PDF('decoy').toString('base64')}`}, 'd.pdf', 10) RETURNING id`)[0]!.id;
    await expect(asApp(() => sql`UPDATE mcp_upload_intents SET status = 'finalized', result_document_id = ${String(decoy)}::UUID
      WHERE id = ${id}::UUID`)).rejects.toThrow(/upload intent/);
    const done = await finalize(fx, [id]);
    expect((done.files as Json[])[0]).toMatchObject({ status: 'finalized', duplicate: false });
  });

  it('app_service (the PUT route\'s pool) can stage bytes and sweep', async () => {
    const a = PDF('service');
    const u = first(await createUrls(fx, [bankFile(lines[7]!, 'svc.pdf', a)]));
    const client = await fx.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_service');
      expect(await runOn(fx, client, () => stageUploadBytes(fx.companyId, String(u.upload_id), a))).toBe(true);
      // The route's audit row for the PUT is written in the same service transaction.
      await runOn(fx, client, () => logAuditOrThrow({ companyId: fx.companyId, userId: fx.userId, action: 'update',
        entityType: 'mcp_upload_intent', entityId: String(u.upload_id), changes: { fields: [], metadata: { source: 'mcp upload PUT' } } }));
      // Expire it as the owner (no role may move an expiry later; app_service may not write it at all).
      await client.query('RESET ROLE');
      await client.query("UPDATE mcp_upload_intents SET expires_at = now() - interval '1 minute' WHERE id = $1", [u.upload_id]);
      await client.query('SET LOCAL ROLE app_service');
      expect((await sweepExpiredUploads(client)).cleared).toBeGreaterThanOrEqual(1);
      const [row] = (await client.query('SELECT staged_bytes IS NULL AS cleared FROM mcp_upload_intents WHERE id = $1', [u.upload_id])).rows;
      expect(row.cleared).toBe(true);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('audits a PUT, a refusal at finalize and a duplicate finalize (distinct action)', async () => {
    const a = PDF('audit');
    const u1 = first(await createUrls(fx, [bankFile(lines[5]!, 'a1.pdf', a)]));
    const u3 = first(await createUrls(fx, [bankFile(lines[5]!, 'a2.pdf', a)]));
    expect(await put(String(u1.url), a)).toBe(200);
    expect(await put(String(u3.url), a)).toBe(200);
    await finalize(fx, [u1.upload_id]);
    await finalize(fx, [u3.upload_id]);
    const noScope = PDF('audit scope');
    const u4 = first(await createUrls(fx, [bankFile(lines[5]!, 'a4.pdf', noScope)]));
    expect(await put(String(u4.url), noScope)).toBe(200);
    await finalize(fx, [u4.upload_id], { scopes: ['write:invoices'] });
    const rows = await sql`
      SELECT action, changes->'metadata'->>'source' AS source, changes->'metadata'->>'upload_id' AS upload_id
        FROM audit_log WHERE company_id = ${fx.companyId}::UUID
         AND changes->'metadata'->>'upload_id' = ANY(${[u1.upload_id, u3.upload_id, u4.upload_id].map(String)})`;
    const of = (id: unknown, source: string) => rows.filter((r) => r.upload_id === id && r.source === source).map((r) => r.action);
    expect(of(u1.upload_id, 'mcp upload PUT')).toEqual(['update']);
    expect(of(u1.upload_id, 'mcp finalize_uploads')).toEqual(['create']);
    expect(of(u3.upload_id, 'mcp finalize_uploads')).toEqual(['update']);
    expect(of(u4.upload_id, 'mcp finalize_uploads')).toEqual(['reject']);
  });
});
