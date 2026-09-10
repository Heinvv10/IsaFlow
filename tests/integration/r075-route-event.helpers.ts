/**
 * R-075 fixture plumbing: fake req/res for the real upload route, a second
 * request that holds its own transaction open, and an AFTER UPDATE trigger that
 * records which backend / transaction / role / claims each capture write ran in.
 */
import { Readable } from 'node:stream';
import type { Pool } from 'pg';

export type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

export const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b30000000049454e44ae426082', 'hex');
const CSRF = 'disposable-postgres-workflow-csrf-0123456789';

export function response() {
  return {
    statusCode: 200, body: undefined as unknown, headersSent: false,
    status(code: number) { this.statusCode = code; return this; },
    setHeader() { return this; }, getHeader() { return undefined; },
    json(body: unknown) { this.body = body; return this.end(); },
    end(..._a: unknown[]) { return this; },
  };
}

function cookieJar(token: string, company: string) {
  const cookies = { 'sb-access-token': token, active_company_id: company, isaflow_csrf: CSRF };
  return { cookies, cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') };
}

/** Multipart upload of `count` PNGs; `auth` is a session (token+company) or a raw API key. */
export function uploadReq(auth: { token: string; company: string } | { apiKey: string }, count = 1) {
  const boundary = '----fixtureR075';
  const parts: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="r075-${i}.png"\r\nContent-Type: image/png\r\n\r\n`), PNG, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  const jar = 'apiKey' in auth ? { cookies: {}, cookie: '' } : cookieJar(auth.token, auth.company);
  const headers: Record<string, string> = {
    'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length),
  };
  if ('apiKey' in auth) headers.authorization = `Bearer ${auth.apiKey}`;
  else Object.assign(headers, { cookie: jar.cookie, 'x-csrf-token': CSRF });
  const r = Readable.from([body]) as unknown as Record<string, unknown>;
  Object.assign(r, {
    method: 'POST', url: '/api/accounting/capture/upload', cookies: jar.cookies, query: {}, headers,
    socket: { remoteAddress: '127.0.0.75' },
  });
  return r;
}

function plainReq(token: string, company: string) {
  const { cookies, cookie } = cookieJar(token, company);
  return { method: 'POST', url: '/api/accounting/r075-concurrent', cookies, query: {},
    headers: { cookie, 'x-csrf-token': CSRF }, socket: { remoteAddress: '127.0.0.76' } };
}

/**
 * A second withAuth request that writes a marker row, then holds its
 * transaction open until `finish()` — the window in which a stray statement
 * from the upload would land inside it.
 */
export async function concurrentRequest(pool: Pool, token: string, company: string) {
  const { withAuth } = await import('@/lib/auth/withAuth');
  const { sql } = await import('@/lib/neon');
  const holding = deferred<void>(), release = deferred<void>();
  const info: { pid?: number; txid?: string; error?: string } = {};
  const marker = crypto.randomUUID();
  const handler = async (_req: unknown, res: ReturnType<typeof response>) => {
    try {
      const [me] = await sql`SELECT pg_backend_pid() AS pid, txid_current()::text AS txid`;
      info.pid = me!.pid as number; info.txid = me!.txid as string;
      await sql`INSERT INTO captured_documents (id, company_id, file_name, file_type, file_size, document_type, status)
        VALUES (${marker}::uuid, ${company}, 'r075-marker', 'png', 1, 'invoice', 'pending')`;
      holding.resolve();
      await release.promise;
      await sql`SELECT 1`;
      res.status(200).json({ ok: true });
    } catch (err) {
      info.error = err instanceof Error ? err.message : String(err);
      holding.resolve();
      res.status(500).json({ ok: false, error: info.error });
    }
  };
  const res = response();
  const done = withAuth(handler as never)(plainReq(token, company) as never, res as never);
  await holding.promise;
  return {
    info,
    finish: async () => {
      release.resolve(); await done;
      const n = (await pool.query('SELECT count(*)::int AS n FROM captured_documents WHERE id=$1', [marker])).rows[0].n;
      return { status: res.statusCode, markerPersisted: n === 1, ...info };
    },
  };
}

export async function waitFor(cond: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** Record every capture UPDATE for `companies`: backend, transaction, role, claims. */
export async function installWriteLog(pool: Pool, companies: string[]) {
  await pool.query(`CREATE TABLE IF NOT EXISTS r075_write_log (id serial, tbl text, row_id uuid, new_status text,
    pid int, txid text, role text, claims text, company text)`);
  await pool.query('GRANT INSERT, SELECT ON r075_write_log TO app_user');
  await pool.query('GRANT USAGE ON SEQUENCE r075_write_log_id_seq TO app_user');
  await pool.query(`CREATE OR REPLACE FUNCTION r075_write_log_fn() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN INSERT INTO r075_write_log(tbl,row_id,new_status,pid,txid,role,claims,company) VALUES
      (TG_TABLE_NAME, NEW.id, NEW.status, pg_backend_pid(), txid_current()::text, current_user,
       current_setting('request.jwt.claims', true), current_setting('app.current_company_id', true));
    RETURN NEW; END $f$`);
  const list = companies.map((c) => `'${c}'`).join(',');
  for (const t of ['capture_events', 'captured_documents']) {
    // Idempotent: an aborted run can leave the trigger behind.
    await pool.query(`SET lock_timeout = '10s'; DROP TRIGGER IF EXISTS r075_write_log_${t} ON ${t}`);
    await pool.query(`SET lock_timeout = '5s'; CREATE TRIGGER r075_write_log_${t} AFTER UPDATE ON ${t} FOR EACH ROW
      WHEN (NEW.company_id::text IN (${list})) EXECUTE FUNCTION r075_write_log_fn()`);
  }
}

export async function removeWriteLog(pool: Pool) {
  for (const t of ['capture_events', 'captured_documents']) {
    await pool.query(`SET lock_timeout = '10s'; DROP TRIGGER IF EXISTS r075_write_log_${t} ON ${t}`);
  }
  await pool.query('DROP FUNCTION IF EXISTS r075_write_log_fn()');
  await pool.query('DROP TABLE IF EXISTS r075_write_log');
}
