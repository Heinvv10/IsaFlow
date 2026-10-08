/**
 * Supplier bank-detail verification — what the DATABASE accepts (migration
 * 876), whoever writes: the one fingerprint definition and its normalisation;
 * `supplier_bank_verified`, derived from the latest row; the table is
 * append-only for every role (grants AND a trigger), tenant-scoped under RLS,
 * and refuses a row the service would never write — another person's name, a
 * fingerprint that is not the supplier's current one, a setter's plain
 * `verified`, a baseline outside the switch-on, a verify while the control is
 * off. Forged as app_user with real request claims, not through the service.
 * The boundary (memory: an app_user session can set its own claims): these
 * guards stop application bugs and mis-wired paths, not an attacker who
 * already runs arbitrary SQL as app_user.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { cleanupPr5, plantSupplier } from './r035-pr5.helpers';
import { bankCompany, bankRoutes, verificationsOf } from './supplier-bank-verification.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
/** a, b, c are members of every enforced() company; d never is. */
const u = { a: '', b: '', c: '', d: '' };
const r = bankRoutes(pool, tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr5(pool, companies, Object.values(u)));

const fp = async (...cols: (string | null)[]) => (await pool.query(
  'SELECT supplier_bank_fingerprint($1, $2, $3, $4, $5) AS f', cols)).rows[0].f as string;

describe('supplier_bank_fingerprint', () => {
  const base = ['FNB', '62000000001', '250655', 'current', 'Acme (Pty) Ltd'] as const;

  it('is sha256 hex, and ignores spaces, dashes, case and surrounding or repeated whitespace', async () => {
    const f = await fp(...base);
    expect(f).toMatch(/^[0-9a-f]{64}$/);
    expect(await fp(' fnb ', '62-000 000-001', '250 655', 'CURRENT', '  ACME  (pty)   ltd ')).toBe(f);
  });

  it('every column counts, and a NULL is not an empty-string accident of a neighbour', async () => {
    const f = await fp(...base);
    for (let i = 0; i < base.length; i++) {
      const moved = [...base] as (string | null)[];
      moved[i] = i === 1 ? '62000000002' : i === 2 ? '250656' : `${base[i]}x`;
      expect(await fp(...moved), `column ${i}`).not.toBe(f);
      moved[i] = null;
      expect(await fp(...moved), `column ${i} NULL`).not.toBe(f);
    }
    // '' and whitespace are absences; so is an account or branch with no digit in it.
    expect(await fp('', '-', ' ', null, '  ')).toBe(await fp(null, null, null, null, null));
    // Moving a value between columns is a different set of details.
    expect(await fp('FNB', '250655', '62000000001', 'current', 'Acme (Pty) Ltd')).not.toBe(f);
  });
});

/** `fn` as app_user inside a withAuth-shaped transaction: claims for `user`, company GUC `company`. Rolled back. */
async function asApp<T>(user: string, company: string, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, session_id: crypto.randomUUID() })]);
    await db.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
    await db.query('SET LOCAL ROLE app_user');
    return await fn(db);
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
}

const current = async (s: string) => (await pool.query(
  `SELECT supplier_bank_fingerprint(bank_name, bank_account_number, bank_branch_code, bank_account_type, bank_account_holder) AS f
   FROM suppliers WHERE id = $1`, [s])).rows[0].f as string;

const insert = (db: PoolClient, c: string, s: string, f: string, by: string, kind = 'verified') => db.query(
  `INSERT INTO supplier_bank_verifications(company_id, supplier_id, fingerprint, kind, method, note, verified_by, roster_snapshot)
   VALUES($1, $2, $3, $4, CASE WHEN $4 = 'baseline' THEN NULL ELSE 'other' END,
          CASE WHEN $4 = 'baseline' THEN NULL ELSE 'forged' END, $5, CASE WHEN $4 = 'self_verified' THEN '{}'::JSONB END)`,
  [c, s, f, kind, by]);

async function enforced() {
  const { company: c } = await bankCompany(pool, [[u.a, 'admin'], [u.b, 'owner'], [u.c, 'admin']], companies);
  const s = await plantSupplier(pool, c);
  expect((await r.toggle(u.b, c, true)).state.statusCode).toBe(200);
  await r.changeBank(u.a, c, s, { bankAccountNumber: '62444444444' });
  return { c, s };
}

describe('supplier_bank_verifications as app_user', () => {
  it('a well-formed row by the session user, at the current fingerprint, is accepted (the premise)', async () => {
    const { c, s } = await enforced();
    await asApp(u.c, c, async (db) => {
      await insert(db, c, s, await current(s), u.c);
      expect((await db.query('SELECT supplier_bank_verified($1, $2) AS v', [c, s])).rows[0].v).toBe(true);
    });
  });

  it('a row inserted with an overriding huge seq is not "latest for ever": a later verification still decides', async () => {
    const { c, s } = await enforced();
    const pinned = async (db: PoolClient) => db.query(
      `INSERT INTO supplier_bank_verifications(seq, company_id, supplier_id, fingerprint, kind, method, note, verified_by)
       OVERRIDING SYSTEM VALUE VALUES(9000000000000000000, $1, $2, $3, 'verified', 'other', 'pinned', $4)`, [c, s, await current(s), u.c]);
    const committed = await pool.connect();
    try {
      await committed.query('BEGIN');
      await committed.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: u.c, session_id: crypto.randomUUID() })]);
      await committed.query("SELECT set_config('app.current_company_id', $1, true)", [c]);
      await committed.query('SET LOCAL ROLE app_user');
      await pinned(committed);
      await committed.query('COMMIT');
    } finally {
      committed.release();
    }
    await r.changeBank(u.a, c, s, { bankAccountNumber: '62555555555' });
    expect((await r.state(u.b, c, s)).state).toBe('unverified');
    expect((await r.verify(u.c, c, s)).state.statusCode).toBe(200);
    expect((await r.state(u.b, c, s)).state).toBe('verified');
  });

  it('refuses UPDATE and DELETE (no grant) — append-only', async () => {
    const { c, s } = await enforced();
    for (const stmt of ["UPDATE supplier_bank_verifications SET note = 'x' WHERE supplier_id = $1",
      'DELETE FROM supplier_bank_verifications WHERE supplier_id = $1']) {
      await expect(asApp(u.b, c, (db) => db.query(stmt, [s]))).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('refuses a row naming someone other than the session user', async () => {
    const { c, s } = await enforced();
    await expect(asApp(u.a, c, async (db) => insert(db, c, s, await current(s), u.c))).rejects.toThrow();
  });

  it('refuses a fingerprint that is not the supplier\'s current one', async () => {
    const { c, s } = await enforced();
    const stale = await fp('R035 Bank', '62000000001', '250655', 'current', 'R035 Holder');
    await expect(asApp(u.c, c, (db) => insert(db, c, s, stale, u.c))).rejects.toThrow(/current bank details/);
  });

  it("refuses a setter's plain verified, and a baseline outside the switch-on", async () => {
    const { c, s } = await enforced();
    await expect(asApp(u.a, c, async (db) => insert(db, c, s, await current(s), u.a))).rejects.toThrow(/set these bank details/);
    await expect(asApp(u.c, c, async (db) => insert(db, c, s, await current(s), u.c, 'baseline'))).rejects.toThrow(/baseline/);
  });

  it('refuses a baseline of details the switcher set, even inside the switch-on transaction', async () => {
    const { company: c } = await bankCompany(pool, [[u.a, 'admin']], companies);
    const s = await plantSupplier(pool, c);
    await pool.query('UPDATE suppliers SET bank_details_setters = ARRAY[$1::UUID] WHERE id = $2', [u.a, s]);
    await expect(asApp(u.a, c, async (db) => {
      await db.query("INSERT INTO approval_enforcement(company_id, document_type, enabled_by) VALUES($1, 'supplier_bank_details', $2)", [c, u.a]);
      await insert(db, c, s, await current(s), u.a, 'baseline');
    })).rejects.toThrow(/set these bank details/);
  });

  it('refuses a baseline for a supplier that already has verification history', async () => {
    const { c, s } = await enforced();
    await pool.query("DELETE FROM approval_enforcement WHERE company_id = $1 AND document_type = 'supplier_bank_details'", [c]);
    await pool.query("UPDATE suppliers SET bank_details_setters = '{}' WHERE id = $1", [s]);
    await expect(asApp(u.b, c, async (db) => {
      await db.query("INSERT INTO approval_enforcement(company_id, document_type, enabled_by) VALUES($1, 'supplier_bank_details', $2)", [c, u.b]);
      await insert(db, c, s, await current(s), u.b, 'baseline');
    })).rejects.toThrow(/history/);
  });

  it('refuses a verify while the control is off', async () => {
    const { company: c } = await bankCompany(pool, [[u.c, 'admin']], companies);
    const s = await plantSupplier(pool, c);
    await expect(asApp(u.c, c, async (db) => insert(db, c, s, await current(s), u.c))).rejects.toThrow(/not enforced/);
  });

  it("cannot see or write another company's rows", async () => {
    const { c, s } = await enforced();
    const { company: other } = await bankCompany(pool, [[u.d, 'admin']], companies);
    await asApp(u.d, other, async (db) => {
      expect((await db.query('SELECT count(*)::INT AS n FROM supplier_bank_verifications WHERE supplier_id = $1', [s])).rows[0].n).toBe(0);
      expect((await db.query('SELECT supplier_bank_verified($1, $2) AS v', [c, s])).rows[0].v).toBe(false);
    });
    await expect(asApp(u.d, other, async (db) => insert(db, c, s, await current(s), u.d))).rejects.toThrow();
  });
});

describe('every other role', () => {
  it('the append-only trigger refuses UPDATE, DELETE and TRUNCATE even from the owner role', async () => {
    const { s } = await enforced();
    await expect(pool.query("UPDATE supplier_bank_verifications SET note = 'x' WHERE supplier_id = $1", [s])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM supplier_bank_verifications WHERE supplier_id = $1', [s])).rejects.toThrow(/append-only/);
    await expect(pool.query('TRUNCATE supplier_bank_verifications')).rejects.toThrow(/append-only/);
    expect(await verificationsOf(pool, s)).toHaveLength(1);
  });

  it('no role but the owner holds UPDATE, DELETE or TRUNCATE; app_user holds only SELECT and INSERT', async () => {
    const { rows } = await pool.query(`
      SELECT grantee, privilege_type FROM information_schema.role_table_grants
      WHERE table_name = 'supplier_bank_verifications'
        AND grantee <> (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'supplier_bank_verifications'::regclass)
      ORDER BY 1, 2`);
    expect(rows).toEqual([{ grantee: 'app_user', privilege_type: 'INSERT' }, { grantee: 'app_user', privilege_type: 'SELECT' }]);
    expect((await pool.query(`SELECT relrowsecurity AND relforcerowsecurity AS f FROM pg_class
      WHERE oid = 'supplier_bank_verifications'::regclass`)).rows[0].f).toBe(true);
  });

  it('deleting the supplier takes its verifications with it (the purge of a soft-deleted supplier is not blocked)', async () => {
    const { s } = await enforced();
    await pool.query('DELETE FROM suppliers WHERE id = $1', [s]);
    expect(await verificationsOf(pool, s)).toEqual([]);
  });

  it('every function the migration creates pins search_path with pg_temp last', async () => {
    const { rows } = await pool.query(`
      SELECT p.proname, array_to_string(p.proconfig, ',') AS cfg FROM pg_proc p
      WHERE p.proname IN ('supplier_bank_fingerprint', 'supplier_bank_details_present', 'supplier_bank_verified',
                          'supplier_bank_verification_guard', 'supplier_bank_verification_append_only')
      ORDER BY 1`);
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row.cfg, row.proname).toMatch(/^search_path=.*pg_temp$/);
  });
});
