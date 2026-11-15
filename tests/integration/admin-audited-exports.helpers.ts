/**
 * Shared harness for the admin audit-row suites (WP10, audit 3.5 / 3.8): call a real
 * admin route (withAdmin -> withPlatformAdmin on the disposable fixture) and read
 * what it answered, streamed or sent, plus the admin_audit_log rows it left.
 */
import type { Pool } from 'pg';
import { request } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

export interface Answer {
  status: number;
  /** Everything written to the body: res.write chunks + res.send / res.end payload. */
  text: string;
  /** The parsed JSON body when the answer was JSON. */
  json: { success?: boolean; data?: unknown; error?: { message?: string } } | null;
  headers: Map<string, unknown>;
}

function response() {
  const headers = new Map<string, unknown>();
  const chunks: string[] = [];
  const state = {
    statusCode: 200, headersSent: false,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return this; },
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
    removeHeader(name: string) { headers.delete(name.toLowerCase()); },
    write(chunk: unknown) { this.headersSent = true; chunks.push(String(chunk)); return true; },
    json(body: unknown) { return this.end(JSON.stringify(body)); },
    send(body: unknown) { return this.end(typeof body === 'string' ? body : JSON.stringify(body)); },
    end(body?: unknown) { if (body !== undefined && body !== null) chunks.push(String(body)); return this; },
    destroy() { return this; },
  };
  return { res: state, chunks, headers };
}

type Route = (req: never, res: never) => Promise<unknown>;

export async function callAdminRoute(
  admin: string, route: unknown, method: string, url: string,
  query: Record<string, string> = {}, body?: unknown,
): Promise<Answer> {
  const jar = { 'sb-access-token': await signSession(admin, crypto.randomUUID(), 'aal2') };
  const req = request(jar, method) as unknown as { body: unknown; url: string; query: Record<string, string> };
  req.url = url;
  req.query = query;
  req.body = body;
  const out = response();
  await (route as Route)(req as never, out.res as never);
  const text = out.chunks.join('');
  let json: Answer['json'] = null;
  try { json = JSON.parse(text) as Answer['json']; } catch { json = null; } // a CSV body is not JSON
  return { status: out.res.statusCode, text, json, headers: out.headers };
}

export interface AuditRow { action: string; target_type: string; target_id: string | null; details: Record<string, unknown> | null }

export async function auditRows(pool: Pool, admin: string, action: string): Promise<AuditRow[]> {
  const r = await pool.query(
    `SELECT action, target_type, target_id, details FROM admin_audit_log
      WHERE admin_user_id = $1 AND action = $2 ORDER BY created_at, id`, [admin, action]);
  return r.rows as AuditRow[];
}

export async function seedSuperAdmin(pool: Pool, admin: string): Promise<void> {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`,
    [admin, `${admin}@test.local`]);
}

/** CSV body -> data lines (header dropped, trailing blank line dropped). */
export function csvDataLines(text: string): string[] {
  return text.split('\n').slice(1).filter((l) => l.length > 0);
}
