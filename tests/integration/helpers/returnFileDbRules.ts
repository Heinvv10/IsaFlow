/**
 * Row builders and the app_user session shared by the table-rule suites tax-return-file-db and
 * tax-return-file-db-submissions (wave 5 L1b). `setOwner` names company A of the suite: its admin is the session user the
 * stamps must name, and its pool runs the statements.
 */
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import type { ReturnFixture } from './returnVersionsFixture';

type Row = Record<string, unknown>;
let current: ReturnFixture | null = null;
export function setOwner(f: ReturnFixture): void { current = f; }
function owner(): ReturnFixture {
  if (!current) throw new Error('setOwner first');
  return current;
}

export const day = (m: number, last = false) => `2026-${String(m).padStart(2, '0')}-${last ? '28' : '01'}`;

export async function submission(f: ReturnFixture, m: number, status = 'submitted', form = 'EMP201'): Promise<string> {
  return String(((await sql`INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, submission_reference)
    VALUES (${f.fx.companyId}::UUID, ${form}, ${day(m)}::DATE, ${day(m, true)}::DATE, ${status}, 'R') RETURNING id`) as Row[])[0]!.id);
}

/** An EMP201 version of month m in the given state, inserted as the table owner (the fixture is not under test). */
export async function version(f: ReturnFixture, m: number, state: 'finalised' | 'filed' | 'superseded'): Promise<string> {
  const sub = state === 'filed' ? await submission(f, m) : null;
  const rows = (await sql`INSERT INTO tax_return_versions (company_id, form_type, period_start, period_end, version_no, figures,
    posted_through, finalised_by, status, sars_submission_id, filed_reference, filed_by, filed_at, amended_by, amend_reason, amended_at)
    VALUES (${f.fx.companyId}::UUID, 'EMP201', ${day(m)}::DATE, ${day(m, true)}::DATE, 1, '{}', now(), ${f.admin.userId}, ${state},
      ${sub}::UUID, ${sub ? 'REF' : null}, ${sub ? 'u' : null}, ${sub ? new Date().toISOString() : null}::TIMESTAMPTZ,
      ${state === 'superseded' ? 'u' : null}, ${state === 'superseded' ? 'why' : null},
      ${state === 'superseded' ? new Date().toISOString() : null}::TIMESTAMPTZ) RETURNING id`) as Row[];
  return String(rows[0]!.id);
}

export async function asAppUser<T>(f: ReturnFixture, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await owner().fx.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: f.admin.userId })]);
    await c.query(`SELECT set_config('app.current_company_id', $1, true)`, [f.fx.companyId]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

/** 'ok', or `<code> <message>` of one statement, in its own savepoint. */
export async function failOf(c: PoolClient, text: string, params: unknown[] = []): Promise<string> {
  await c.query('SAVEPOINT f');
  try {
    await c.query(text, params);
    return 'ok';
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT f');
    const e = err as { code: string; message: string };
    return `${e.code} ${e.message}`;
  } finally {
    await c.query('RELEASE SAVEPOINT f').catch(() => undefined);
  }
}

export const upd = (id: string, set: string) => `UPDATE tax_return_versions SET ${set} WHERE id = '${id}'`;
export const U = () => owner().admin.userId; // the session user asAppUser sets: filed_by and amended_by must be this
export const FILE = (sub: string) => `status = 'filed', sars_submission_id = '${sub}', filed_reference = 'R1', filed_by = '${U()}', filed_at = now()`;
export const AMEND = () => `status = 'superseded', amended_by = '${U()}', amend_reason = 'why', amended_at = now()`;
export const INVISIBLE = [0x200b, 0x200c, 0xfeff, 0x00a0, 0x2003].map((c) => String.fromCharCode(c)).join(' ');
/** Ends and middles of every invisible range the guards cover (returnGuards.ts and 971 hold the same set). */
export const INVISIBLE_POINTS = [0xad, 0x85, 0xa0, 0x34f, 0x115f, 0x1160, 0x1680, 0x17b4, 0x17b5, 0x180b, 0x180e, 0x180f, 0x2000, 0x200b, 0x200f,
  0x2028, 0x202f, 0x205f, 0x2060, 0x206f, 0x2800, 0x3000, 0x3164, 0xfe00, 0xfe0f, 0xfeff, 0xffa0, 0xe0000, 0xe0020, 0xe0fff,
  0x61c, 0xfff9, 0xfffa, 0xfffb, 0x13430, 0x1343f, 0x1bca0, 0x1bca3, 0x1d173, 0x1d17a];
