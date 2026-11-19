/**
 * Shared by the MCP upload suites (999q): complete PDF / PNG / JPEG bodies, a PUT against the token route the way a
 * plain `curl -T` sends it, and the two tools run as a real MCP call runs them: one app_user transaction with the
 * member's claims (withBearerAuth's shape), so the table grants, the guard trigger and RLS all apply.
 */
import { Readable } from 'stream';
import { createHash } from 'crypto';
import { sql } from '@/lib/neon';
import { createUploadUrlsTool } from '@/lib/mcp/tools/writeCreateUploadUrls';
import { finalizeUploadsTool } from '@/lib/mcp/tools/writeFinalizeUploads';
import type { McpToolContext } from '@/lib/mcp/types';
import putRoute from '../../../pages/api/mcp/uploads/[token]';
import { inAppUserTx } from './appUserTx';
import type { Fixture } from './l1FifoFixture';

export type Json = Record<string, unknown>;

const PNG_HEAD = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const PNG_IEND = Buffer.from('0000000049454e44ae426082', 'hex');
const JPG_HEAD = Buffer.from('ffd8ffe000104a464946', 'hex');
const JPG_EOI = Buffer.from('ffd9', 'hex');

export const PDF = (s: string | number) => Buffer.from(`%PDF-1.4\n% ${s}\n%%EOF\n`);
export const PNG = (s: string | number) => Buffer.concat([PNG_HEAD, Buffer.from(`png ${s}`), PNG_IEND]);
export const JPG = (s: string | number) => Buffer.concat([JPG_HEAD, Buffer.from(`jpg ${s}`), JPG_EOI]);
export const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const json = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text) as Json;

/** PUT `bytes` (or `chunks`) to an upload url; resolves the status code. */
export async function put(
  url: string, bytes: Buffer, opts: { headers?: Record<string, string>; chunks?: Buffer[] } = {},
): Promise<number> {
  const token = url.split('/').pop()!;
  const req = Object.assign(Readable.from(opts.chunks ?? [bytes]), {
    method: 'PUT', headers: opts.headers ?? { 'content-length': String(bytes.length) }, socket: {},
    url: `/api/mcp/uploads/${token}`, query: { token },
  });
  const res = { statusCode: 200, headersSent: false, status(c: number) { res.statusCode = c; return res; },
    json() { return res; }, setHeader() { return res; }, getHeader() { return undefined; }, on() { return res; },
    once() { return res; }, end() { return res; } };
  await (putRoute as (q: unknown, s: unknown) => Promise<unknown>)(req, res);
  return res.statusCode;
}

/** The fixture's user as a member of its company (the tenant policy shows a non-member nothing). */
export async function seedMember(fx: Fixture): Promise<void> {
  await sql`INSERT INTO users (id, email, role, is_active) VALUES (${fx.userId}, ${`${fx.tag}@test.local`}, 'admin', true)`;
  await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${fx.companyId}::UUID, ${fx.userId}, 'admin')`;
}

export async function dropUploads(fx: Fixture): Promise<void> {
  await sql`DELETE FROM mcp_upload_intents WHERE company_id = ${fx.companyId}::UUID`;
  await sql`DELETE FROM audit_log WHERE company_id = ${fx.companyId}::UUID`;
  await sql`DELETE FROM company_users WHERE company_id = ${fx.companyId}::UUID`;
}

export const toolCtx = (fx: Fixture, over: Partial<McpToolContext> = {}): McpToolContext =>
  ({ userId: fx.userId, companyId: fx.companyId, scopes: ['write:invoices', 'write:bank-tx'], tokenJti: 'j', oauthAppId: null, ...over });

let key = 0;
/** create_upload_urls as `fx`'s member, in its own app_user transaction. */
export const createUrls = (fx: Fixture, files: unknown[], over: Partial<McpToolContext> = {}) =>
  inAppUserTx(fx, async () => json(await createUploadUrlsTool.handler({ files, idempotency_key: `c${key++}` }, toolCtx(fx, over))));

/** finalize_uploads as `fx`'s member, in its own app_user transaction. */
export const finalize = (fx: Fixture, ids: unknown[], over: Partial<McpToolContext> = {}) =>
  inAppUserTx(fx, async () => json(await finalizeUploadsTool.handler({ upload_ids: ids, idempotency_key: `f${key++}` }, toolCtx(fx, over))));

/** A create_upload_urls file entry for a bank line. */
export const bankFile = (line: string, name: string, b: Buffer, mime = 'application/pdf') =>
  ({ target: { bank_transaction_id: line }, file_name: name, mime_type: mime, size: b.length, sha256: sha(b) });

export const attachmentsOn = async (line: string): Promise<number> => Number((await sql`
  SELECT count(*) AS n FROM bank_transaction_attachments WHERE bank_transaction_id = ${line}::UUID`)[0]!.n);
