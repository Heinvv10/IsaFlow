/**
 * M14 record comments on real PostgreSQL, two tenants: the write path as app_user (withAuth's role) through the service.
 * A record of the other company is 404 with no row; the lowest commenting role (manager) mentions an owner and a viewer and
 * both are notified in-app; a refused request leaves no row and no notification; only the author edits or deletes (service
 * 403, and the table's own 42501); deleted is final; Login-as is refused; the table refuses a forged author and an over-long body.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { createComment, deleteComment, editComment, listComments } from '@/modules/accounting/services/comments/recordCommentService';
import { CommentError, MAX_COMMENT_BODY } from '@/modules/accounting/services/comments/commentText';
import { ImpersonationForbiddenError } from '@/lib/auth/impersonationGuard';
import { getBankTransactionById } from '@/modules/accounting/services/bank/bankTxSingleLine';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const [A, B] = [crypto.randomUUID(), crypto.randomUUID()];
const [owner, manager, viewer, bUser, admin] = [1, 2, 3, 4, 5].map(() => crypto.randomUUID());
const LOGIN_AS = `m14-${crypto.randomUUID()}`;
const ids = { invA: '', invB: '', billA: '', bankA: '', bankB: '' };

async function one(sql: string, params: unknown[]): Promise<string> {
  return (await pool.query<{ id: string }>(sql, params)).rows[0]!.id;
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)', [A, 'M14 A', B, 'M14 B']);
  const names: Array<[string, string]> = [[owner, 'Olive'], [manager, 'Mandla'], [viewer, 'Vera'], [bUser, 'Bongi'], [admin, 'Adam']];
  for (const [u, first] of names) {
    await pool.query("INSERT INTO users (id, email, role, is_active, first_name, last_name) VALUES ($1, $2, 'admin', true, $3, 'Tester')",
      [u, `${u}@test.local`, first]);
  }
  await pool.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'manager'),
                    ($1, $4, 'viewer'), ($1, $6, 'admin'), ($5, $7, 'owner')`, [A, owner, manager, viewer, B, admin, bUser]);
  await pool.query("INSERT INTO impersonation_sessions (session_id, actor_user_id, target_user_id) VALUES ($1, $2, $3)", [LOGIN_AS, owner, manager]);
  const custA = await one('INSERT INTO customers (company_id, name) VALUES ($1, $2) RETURNING id', [A, 'M14 cust A']);
  const custB = await one('INSERT INTO customers (company_id, name) VALUES ($1, $2) RETURNING id', [B, 'M14 cust B']);
  const supA = await one('INSERT INTO suppliers (company_id, name) VALUES ($1, $2) RETURNING id', [A, 'M14 sup A']);
  const inv = (co: string, cust: string, n: string) => one(`INSERT INTO customer_invoices (company_id, invoice_number, customer_id, client_id, subtotal, total_amount, created_by, status)
    VALUES ($1, $2, $3, $3, 100, 115, $4, 'draft') RETURNING id`, [co, n, cust, owner]);
  ids.invA = await inv(A, custA, `M14-A-${A.slice(0, 6)}`);
  ids.invB = await inv(B, custB, `M14-B-${B.slice(0, 6)}`);
  ids.billA = await one(`INSERT INTO supplier_invoices (company_id, invoice_number, supplier_id, invoice_date, subtotal, total_amount, created_by, status)
    VALUES ($1, $2, $3, CURRENT_DATE, 100, 115, $4, 'draft') RETURNING id`, [A, `M14-BILL-${A.slice(0, 6)}`, supA, owner]);
  const bank = (co: string, tag: string) => one(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
    VALUES ($1, $2, 'M14 bank', 'asset', 'debit', 3) RETURNING id`, [co, `M14${tag}`]).then((acct) =>
    one(`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description)
         VALUES ($1, $2, CURRENT_DATE, 50, 'M14 line') RETURNING id`, [co, acct]));
  ids.bankA = await bank(A, 'A');
  ids.bankB = await bank(B, 'B');
}, 60_000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM user_notifications WHERE company_id = ANY($1)', [[A, B]]);
    await pool.query('DELETE FROM record_comments WHERE company_id = ANY($1)', [[A, B]]);
    await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [[A, B]]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id = ANY($1)', [[A, B]]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id = ANY($1)', [[A, B]]);
    await pool.query('DELETE FROM impersonation_sessions WHERE session_id = $1', [LOGIN_AS]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1)', [[A, B]]);
    await pool.query('DELETE FROM customers WHERE company_id = ANY($1)', [[A, B]]);
    await pool.query('DELETE FROM suppliers WHERE company_id = ANY($1)', [[A, B]]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1)', [[A, B]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[A, B]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::TEXT[])', [[owner, manager, viewer, bUser, admin]]);
  } finally { await pool.end(); }
});

/** One rolled-back request as app_user: claims for `user` (and `session` when Login-as) in `co`. `admin()` runs as the fixture's superuser. */
async function as<T>(co: string, user: string, fn: (c: { admin: <R>(q: string, p?: unknown[]) => Promise<R[]>; raw: (q: string, p?: unknown[]) => Promise<unknown> }) => Promise<T>, session?: string): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, ...(session ? { session_id: session } : {}) })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [co]);
    const helpers = {
      admin: async <R,>(q: string, p: unknown[] = []) => {
        await client.query('SAVEPOINT adm'); await client.query('RESET ROLE');
        try { return (await client.query(q, p)).rows as R[]; } finally { await client.query('SET LOCAL ROLE app_user'); await client.query('RELEASE SAVEPOINT adm'); }
      },
      raw: (q: string, p: unknown[] = []) => client.query(q, p),
    };
    return await als.run({ client, companyId: co, userId: user, claims: { sub: user, ...(session ? { session_id: session } : {}) } }, () => fn(helpers));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
type H = Parameters<Parameters<typeof as>[2]>[0];
const count = (h: H, co: string) => h.admin<{ n: number }>('SELECT count(*)::int AS n FROM record_comments WHERE company_id = $1', [co]).then((r) => r[0]!.n);
async function sqlCode(h: H, q: string, p: unknown[]): Promise<string | undefined> {
  await h.raw('SAVEPOINT s');
  try { await h.raw(q, p); await h.raw('RELEASE SAVEPOINT s'); return undefined; } catch (e) {
    await h.raw('ROLLBACK TO SAVEPOINT s'); return (e as { code?: string }).code;
  }
}

describe('create', () => {
  it('a manager comments on an invoice, a bill and a bank line; the author is the session user', async () => {
    await as(A, manager, async (h) => {
      for (const [t, id] of [['customer_invoice', ids.invA], ['supplier_invoice', ids.billA], ['bank_transaction', ids.bankA]] as const) {
        const c = await createComment(A, manager, t, id, `note on ${t}`);
        expect(c.authorId).toBe(manager);
        expect(c.authorName).toBe('Mandla Tester');
        expect((await listComments(A, manager, t, id, true)).comments.map((x) => x.body)).toEqual([`note on ${t}`]);
      }
      expect(await count(h, A)).toBe(3);
    });
  });

  it('XSS text is stored and returned byte for byte (the UI renders it as text)', async () => {
    const xss = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    await as(A, manager, async () => {
      const c = await createComment(A, manager, 'customer_invoice', ids.invA, xss);
      expect(c.body).toBe(xss);
    });
  });

  it('company B\'s record is a 404 from company A, and no row is written', async () => {
    await as(A, manager, async (h) => {
      for (const [t, id] of [['customer_invoice', ids.invB], ['bank_transaction', ids.bankB]] as const) {
        await expect(createComment(A, manager, t, id, 'sneaky')).rejects.toMatchObject({ status: 404 });
        await expect(listComments(A, manager, t, id, true)).rejects.toMatchObject({ status: 404 });
      }
      expect(await count(h, A)).toBe(0);
      expect(await count(h, B)).toBe(0);
    });
  });

  it('the body limit: 4000 characters pass, 4001 is a 400 with no row; the table refuses 4001 too', async () => {
    await as(A, manager, async (h) => {
      await createComment(A, manager, 'customer_invoice', ids.invA, 'x'.repeat(MAX_COMMENT_BODY));
      await expect(createComment(A, manager, 'customer_invoice', ids.invA, 'x'.repeat(MAX_COMMENT_BODY + 1))).rejects.toMatchObject({ status: 400 });
      expect(await count(h, A)).toBe(1);
      expect(await sqlCode(h, "INSERT INTO record_comments (company_id, record_type, record_id, body) VALUES ($1, 'customer_invoice', $2, $3)",
        [A, ids.invA, 'y'.repeat(MAX_COMMENT_BODY + 1)])).toBe('23514');
    });
  });
});

describe('mentions (in-app only)', () => {
  it('the lowest commenting role (manager) mentions an owner and a viewer: both are notified, and the comment is kept', async () => {
    await as(A, manager, async (h) => {
      const c = await createComment(A, manager, 'customer_invoice', ids.invA, '@Olive @Vera please look', [owner, viewer]);
      expect(c.mentions.sort()).toEqual([owner, viewer].sort());
      const n = await h.admin<{ user_id: string; kind: string; href: string; ref_id: string; title: string }>(
        "SELECT user_id, kind, href, ref_id::TEXT, title FROM user_notifications WHERE company_id = $1 AND dedupe_key = $2 ORDER BY user_id", [A, `comment:${c.id}`]);
      expect(n.map((r) => r.user_id).sort()).toEqual([owner, viewer].sort());
      expect(n.every((r) => r.kind === 'comment_mention' && r.href === `/accounting/customer-invoices/${ids.invA}` && r.ref_id === ids.invA)).toBe(true);
      expect(n[0]!.title).toContain('Mandla Tester mentioned you on invoice');
    });
  });

  it('mentioning yourself writes no notification; an edit that adds a person notifies only that person', async () => {
    await as(A, manager, async (h) => {
      const c = await createComment(A, manager, 'customer_invoice', ids.invA, 'note', [manager]);
      expect(c.mentions).toEqual([]);
      await editComment(A, manager, c.id, 'note @Olive', [owner]);
      await editComment(A, manager, c.id, 'note @Olive @Vera', [owner, viewer]);
      const n = await h.admin<{ user_id: string }>('SELECT user_id FROM user_notifications WHERE company_id = $1 AND dedupe_key = $2', [A, `comment:${c.id}`]);
      expect(n.map((r) => r.user_id).sort()).toEqual([owner, viewer].sort());
    });
  });

  it('a person of another company cannot be mentioned: 400, no comment, no notification', async () => {
    await as(A, manager, async (h) => {
      await expect(createComment(A, manager, 'customer_invoice', ids.invA, 'hi @Bongi', [bUser])).rejects.toMatchObject({ status: 400 });
      expect(await count(h, A)).toBe(0);
      expect((await h.admin<{ n: number }>('SELECT count(*)::int AS n FROM user_notifications WHERE company_id = ANY($1)', [[A, B]]))[0]!.n).toBe(0);
    });
  });

  it('the mention list names the colleagues but not the caller or another company\'s people', async () => {
    await as(A, manager, async () => {
      const { mentionable } = await listComments(A, manager, 'customer_invoice', ids.invA, true);
      expect(mentionable.map((m) => m.id).sort()).toEqual([owner, viewer, admin].sort());
    });
  });
  it('a person added on a later edit is told once; people already told are not told again (read state kept)', async () => {
    await as(A, manager, async (h) => {
      const c = await createComment(A, manager, 'customer_invoice', ids.invA, '@Olive', [owner]);
      await h.admin("UPDATE user_notifications SET read_at = now() WHERE company_id = $1 AND dedupe_key = $2 AND user_id = $3", [A, `comment:${c.id}`, owner]);
      await editComment(A, manager, c.id, '@Olive @Vera', [owner, viewer]);
      await editComment(A, manager, c.id, '@Olive @Vera again', [owner, viewer]);
      const n = await h.admin<{ user_id: string; read_at: Date | null }>('SELECT user_id, read_at FROM user_notifications WHERE company_id = $1 AND dedupe_key = $2 ORDER BY user_id', [A, `comment:${c.id}`]);
      expect(n.map((r) => r.user_id).sort()).toEqual([owner, viewer].sort());
      expect(n.find((r) => r.user_id === owner)!.read_at, 'owner was not notified again').not.toBeNull();
      expect(n.find((r) => r.user_id === viewer)!.read_at).toBeNull();
    });
  });

  it('a bank line mention links to that line (account and line in the URL)', async () => {
    await as(A, manager, async (h) => {
      const c = await createComment(A, manager, 'bank_transaction', ids.bankA, 'look at this', [owner]);
      const acct = (await h.admin<{ bank_account_id: string }>('SELECT bank_account_id FROM bank_transactions WHERE id = $1', [ids.bankA]))[0]!.bank_account_id;
      const n = await h.admin<{ href: string }>('SELECT href FROM user_notifications WHERE company_id = $1 AND dedupe_key = $2', [A, `comment:${c.id}`]);
      expect(n[0]!.href).toBe(`/accounting/bank-transactions?account_id=${acct}&line=${ids.bankA}`);
    });
  });

  it('a read-only caller gets the thread but not the colleague list', async () => {
    await as(A, viewer, async () => {
      const out = await listComments(A, viewer, 'customer_invoice', ids.invA, false);
      expect(out.mentionable).toEqual([]);
    });
    await as(A, manager, async () => {
      expect((await listComments(A, manager, 'customer_invoice', ids.invA, true)).mentionable.length).toBeGreaterThan(0);
    });
  });

  it('getBankTransactionById: the company\'s own line, never another company\'s', async () => {
    await as(A, manager, async () => {
      expect((await getBankTransactionById(A, ids.bankA))?.id).toBe(ids.bankA);
      expect(await getBankTransactionById(A, ids.bankB)).toBeNull();
    });
  });
});

describe('author only, soft delete', () => {
  it('another user\'s edit or delete is a 403 and the comment is untouched; at the table the UPDATE is 42501', async () => {
    await as(A, manager, async (h) => {
      const c = await createComment(A, manager, 'customer_invoice', ids.invA, 'mine');
      await h.raw("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: admin })]);
      await expect(editComment(A, admin, c.id, 'hijacked')).rejects.toMatchObject({ status: 403 });
      await expect(deleteComment(A, admin, c.id)).rejects.toMatchObject({ status: 403 });
      expect(await sqlCode(h, 'UPDATE record_comments SET body = $2 WHERE id = $1', [c.id, 'hijacked'])).toBe('42501');
      expect(await sqlCode(h, 'UPDATE record_comments SET deleted_at = now() WHERE id = $1', [c.id])).toBe('42501');
      const row = (await h.admin<{ body: string; deleted_at: Date | null; edited_at: Date | null }>('SELECT body, deleted_at, edited_at FROM record_comments WHERE id = $1', [c.id]))[0]!;
      expect(row).toMatchObject({ body: 'mine', deleted_at: null, edited_at: null });
    });
  });

  it('the author edits (stamping edited_at) and deletes; a deleted comment leaves the list and is final', async () => {
    await as(A, manager, async (h) => {
      const c = await createComment(A, manager, 'customer_invoice', ids.invA, 'first');
      const e = await editComment(A, manager, c.id, 'second');
      expect(e.body).toBe('second');
      expect(e.editedAt).not.toBeNull();
      await deleteComment(A, manager, c.id);
      expect((await listComments(A, manager, 'customer_invoice', ids.invA, true)).comments).toEqual([]);
      await expect(editComment(A, manager, c.id, 'again')).rejects.toMatchObject({ status: 404 });
      await expect(deleteComment(A, manager, c.id)).rejects.toMatchObject({ status: 404 });
      expect(await sqlCode(h, 'UPDATE record_comments SET deleted_at = NULL WHERE id = $1', [c.id])).toBe('23514');
      expect((await h.admin<{ n: number }>('SELECT count(*)::int AS n FROM record_comments WHERE id = $1', [c.id]))[0]!.n).toBe(1);
    });
  });

  it('the table refuses a forged author, a hard DELETE, and an edit of the stamps', async () => {
    await as(A, manager, async (h) => {
      const c = await createComment(A, manager, 'customer_invoice', ids.invA, 'x');
      expect(await sqlCode(h, "INSERT INTO record_comments (company_id, record_type, record_id, body, author_id) VALUES ($1, 'customer_invoice', $2, 'f', $3)", [A, ids.invA, owner])).toBe('42501');
      expect(await sqlCode(h, 'DELETE FROM record_comments WHERE id = $1', [c.id])).toBe('42501');
      expect(await sqlCode(h, 'UPDATE record_comments SET author_id = $2 WHERE id = $1', [c.id, owner])).toBe('42501');
      expect(await sqlCode(h, "UPDATE record_comments SET edited_at = now() - interval '1 year' WHERE id = $1", [c.id])).toBe('42501');
    });
  });

  it('company B cannot see or touch company A\'s comments', async () => {
    await as(A, manager, async (h) => {
      const c = await createComment(A, manager, 'customer_invoice', ids.invA, 'A only');
      await h.raw("SELECT set_config('app.current_company_id', $1, true)", [B]);
      await h.raw("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: bUser })]);
      expect((await h.raw('SELECT count(*)::int AS n FROM record_comments') as { rows: Array<{ n: number }> }).rows[0]!.n).toBe(0);
      await expect(editComment(B, bUser, c.id, 'x')).rejects.toBeInstanceOf(CommentError);
      await expect(deleteComment(B, bUser, c.id)).rejects.toMatchObject({ status: 404 });
    });
  });
});

describe('Login-as', () => {
  it('is refused before any read or write', async () => {
    await as(A, manager, async (h) => {
      await expect(createComment(A, manager, 'customer_invoice', ids.invA, 'as someone else', [owner])).rejects.toBeInstanceOf(ImpersonationForbiddenError);
      expect(await count(h, A)).toBe(0);
    }, LOGIN_AS);
    await as(A, manager, async (h) => {
      const c = await createComment(A, manager, 'customer_invoice', ids.invA, 'mine');
      await h.raw("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: manager, session_id: LOGIN_AS })]);
      await expect(editComment(A, manager, c.id, 'edited as other')).rejects.toBeInstanceOf(ImpersonationForbiddenError);
      await expect(deleteComment(A, manager, c.id)).rejects.toBeInstanceOf(ImpersonationForbiddenError);
      expect((await h.admin<{ body: string }>('SELECT body FROM record_comments WHERE id = $1', [c.id]))[0]!.body).toBe('mine');
    });
  });
});
