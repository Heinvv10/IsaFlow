/**
 * The two-step MCP upload against real Postgres (999q): create_upload_urls → PUT /api/mcp/uploads/<token> →
 * finalize_uploads, with no file bytes in either tool call. A mixed batch (PDF, PNG, JPEG across three bank lines)
 * attaches with two tool calls; re-sending the same batch reports every file duplicate: true and issues no url; a
 * second finalize returns the first result; a wrong sha / wrong mime body is refused; an expired url is refused; another
 * company's line is "Not found"; every finalize leaves an audit_log row. Bank-line targets only: the entity store
 * writes to object storage, which the gate does not run (the entity arm is covered in uploadUrlTools.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Readable } from 'stream';
import { createHash } from 'crypto';
import { sql } from '@/lib/neon';
import { createUploadUrlsTool } from '@/lib/mcp/tools/writeCreateUploadUrls';
import { finalizeUploadsTool } from '@/lib/mcp/tools/writeFinalizeUploads';
import type { McpToolContext } from '@/lib/mcp/types';
import putRoute from '../../pages/api/mcp/uploads/[token]';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, seedBankTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { dropDocuments } from './helpers/documentFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const PDF = (n: number) => Buffer.from(`%PDF-1.4\n% invoice ${n}\n%%EOF\n`);
const PNG = (n: number) => Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from(`png ${n}`)]);
const JPG = (n: number) => Buffer.concat([Buffer.from('ffd8ffe000104a464946', 'hex'), Buffer.from(`jpg ${n}`)]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
type Json = Record<string, unknown>;
const json = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text) as Json;

async function put(url: string, bytes: Buffer): Promise<number> {
  const token = url.split('/').pop()!;
  const req = Object.assign(Readable.from([bytes]), {
    method: 'PUT', headers: { 'content-length': String(bytes.length) }, socket: {}, url: `/api/mcp/uploads/${token}`, query: { token },
  });
  const res = { statusCode: 200, headersSent: false, status(c: number) { res.statusCode = c; return res; },
    json() { return res; }, setHeader() { return res; }, getHeader() { return undefined; }, on() { return res; }, end() { return res; } };
  await (putRoute as (q: unknown, s: unknown) => Promise<unknown>)(req, res);
  return res.statusCode;
}

describeIfDb('MCP create_upload_urls + finalize_uploads (bank lines)', () => {
  let fx: Fixture;
  let other: Fixture;
  let lines: string[];
  let foreignLine: string;
  const ctx = (f: Fixture): McpToolContext =>
    ({ userId: f.userId, companyId: f.companyId, scopes: ['write:invoices', 'write:bank-tx'], tokenJti: 'j', oauthAppId: null });
  const attachmentCount = async () => Number((await sql`
    SELECT count(*) AS n FROM bank_transaction_attachments a JOIN bank_transactions bt ON bt.id = a.bank_transaction_id
     WHERE bt.company_id = ${fx.companyId}::UUID`)[0]!.n);
  const batch = () => {
    const files: { bytes: Buffer; mime: string; name: string; line: string }[] = [];
    for (let n = 0; n < 9; n += 1) {
      const kind = n % 3;
      const bytes = kind === 0 ? PDF(n) : kind === 1 ? PNG(n) : JPG(n);
      files.push({ bytes, mime: ['application/pdf', 'image/png', 'image/jpeg'][kind]!, name: `f${n}.${['pdf', 'png', 'jpg'][kind]}`, line: lines[n % 3]! });
    }
    return files;
  };
  const declare = (files: ReturnType<typeof batch>) => files.map((f) => ({
    target: { bank_transaction_id: f.line }, file_name: f.name, mime_type: f.mime, size: f.bytes.length, sha256: sha(f.bytes),
  }));

  beforeAll(async () => {
    assertNotProductionDb('This test seeds companies, bank lines and attachments.');
    fx = await seedFixture('MCPUPL', DATABASE_URL!);
    other = await seedFixture('MCPUPLB', DATABASE_URL!);
    // audit_log.user_id references users: the finalize audit row needs the actor to exist, as a real token's user does.
    for (const f of [fx, other]) {
      await sql`INSERT INTO users (id, email, role, is_active) VALUES (${f.userId}, ${`${f.tag}@test.local`}, 'admin', true)`;
    }
    lines = [];
    for (let i = 0; i < 3; i += 1) lines.push(await seedBankTx(fx, { date: '2026-11-0' + (i + 1), amount: -100 - i, description: `upl ${i}` }));
    foreignLine = await seedBankTx(other, { date: '2026-11-01', amount: -50, description: 'theirs' });
  }, 120000);

  afterAll(async () => {
    for (const f of [fx, other]) {
      if (!f) continue;
      await dropDocuments(f);
      await sql`DELETE FROM mcp_upload_intents WHERE company_id = ${f.companyId}::UUID`;
      await sql`DELETE FROM audit_log WHERE company_id = ${f.companyId}::UUID`;
      await dropFixture(f);
      await sql`DELETE FROM users WHERE id = ${f.userId}`;
    }
  }, 120000);

  it('attaches a mixed batch with two tool calls and plain PUTs, and audits each finalize', async () => {
    const files = batch();
    const created = json(await createUploadUrlsTool.handler({ files: declare(files), idempotency_key: 'c1' }, ctx(fx)));
    expect(created).toMatchObject({ urls_issued: 9, duplicates: 0, refused: 0 });
    const uploads = created.uploads as Json[];
    expect(JSON.stringify(created)).not.toContain(files[0]!.bytes.toString('base64'));

    for (const [i, u] of uploads.entries()) expect(await put(String(u.url), files[i]!.bytes)).toBe(200);
    // One-shot: the url stops working once used.
    expect(await put(String(uploads[0]!.url), files[0]!.bytes)).toBe(409);

    const done = json(await finalizeUploadsTool.handler({ upload_ids: uploads.map((u) => u.upload_id), idempotency_key: 'f1' }, ctx(fx)));
    expect(done).toMatchObject({ finalized: 9, duplicates: 0, refused: 0 });
    expect(await attachmentCount()).toBe(9);
    const stored = await sql`SELECT a.file_url FROM bank_transaction_attachments a WHERE a.id = ${String((done.files as Json[])[1]!.document_id)}::UUID`;
    expect(String(stored[0]!.file_url)).toBe(`data:image/png;base64,${files[1]!.bytes.toString('base64')}`);
    const staged = await sql`SELECT count(*) AS n FROM mcp_upload_intents WHERE company_id = ${fx.companyId}::UUID AND staged_bytes IS NOT NULL`;
    expect(Number(staged[0]!.n)).toBe(0);
    const audits = await sql`SELECT count(*) AS n FROM audit_log WHERE company_id = ${fx.companyId}::UUID AND changes->'metadata'->>'source' = 'mcp finalize_uploads'`;
    expect(Number(audits[0]!.n)).toBe(9);

    // A second finalize of the same ids returns the same documents and writes nothing.
    const again = json(await finalizeUploadsTool.handler({ upload_ids: uploads.map((u) => u.upload_id), idempotency_key: 'f2' }, ctx(fx)));
    expect((again.files as Json[]).map((f) => f.document_id)).toEqual((done.files as Json[]).map((f) => f.document_id));
    expect(await attachmentCount()).toBe(9);
  });

  it('re-sending the same batch reports every file duplicate: true and issues no url', async () => {
    const res = json(await createUploadUrlsTool.handler({ files: declare(batch()), idempotency_key: 'c2' }, ctx(fx)));
    expect(res).toMatchObject({ urls_issued: 0, duplicates: 9 });
    expect((res.uploads as Json[]).every((u) => u.duplicate === true && u.url === undefined)).toBe(true);
  });

  it('refuses a body whose sha or type differs from the declaration, and an expired url', async () => {
    const real = PDF(100);
    const created = json(await createUploadUrlsTool.handler({ files: [
      { target: { bank_transaction_id: lines[0] }, file_name: 'x.pdf', mime_type: 'application/pdf', size: real.length, sha256: sha(real) },
      { target: { bank_transaction_id: lines[0] }, file_name: 'y.png', mime_type: 'image/png', size: PDF(102).length, sha256: sha(PDF(102)) },
      { target: { bank_transaction_id: lines[1] }, file_name: 'z.pdf', mime_type: 'application/pdf', size: PDF(101).length, sha256: sha(PDF(101)) },
    ], idempotency_key: 'c3' }, ctx(fx)));
    const [a, b, c] = created.uploads as Json[];
    const tampered = Buffer.from(real); tampered[tampered.length - 2] = 0x21;
    expect(await put(String(a!.url), tampered)).toBe(400);
    expect(await put(String(b!.url), PDF(102))).toBe(400);
    await sql`UPDATE mcp_upload_intents SET expires_at = now() - interval '1 minute' WHERE id = ${String(c!.upload_id)}::UUID`;
    expect(await put(String(c!.url), PDF(101))).toBe(409);
    const fin = json(await finalizeUploadsTool.handler({ upload_ids: [a!.upload_id, c!.upload_id], idempotency_key: 'f3' }, ctx(fx)));
    expect((fin.files as Json[]).map((f) => f.status)).toEqual(['not_uploaded', 'expired']);
    expect(await attachmentCount()).toBe(9);
  });

  it('refuses another company\'s line as Not found, and another company cannot finalize our upload', async () => {
    const f = PDF(200);
    const res = json(await createUploadUrlsTool.handler({ files: [
      { target: { bank_transaction_id: foreignLine }, file_name: 'a.pdf', mime_type: 'application/pdf', size: f.length, sha256: sha(f) },
    ], idempotency_key: 'c4' }, ctx(fx)));
    expect((res.uploads as Json[])[0]).toMatchObject({ status: 'refused', error: 'Not found' });

    const mine = json(await createUploadUrlsTool.handler({ files: [
      { target: { bank_transaction_id: lines[2] }, file_name: 'b.pdf', mime_type: 'application/pdf', size: f.length, sha256: sha(f) },
    ], idempotency_key: 'c5' }, ctx(fx)));
    const up = (mine.uploads as Json[])[0]!;
    expect(await put(String(up.url), f)).toBe(200);
    const theirs = json(await finalizeUploadsTool.handler({ upload_ids: [up.upload_id], idempotency_key: 'f4' }, ctx(other)));
    expect((theirs.files as Json[])[0]!.status).toBe('not_found');
    expect(await attachmentCount()).toBe(9);
  });
});
