/**
 * R-035 PR3: what an approval of a credit note vouches for — the
 * customer_credit_note / supplier_credit_note branches of
 * approval_document_digest() (migration 862) — and proof that replacing the
 * function left the supplier-invoice branch, and its authors branch, exactly
 * as 708 / 712 wrote them.
 *
 * Every hashed column moves the digest; every excluded column (reason,
 * status, applied_amount, approval/cancel bookkeeping, external refs, actor
 * columns, timestamps, content_authors) does not; asking for the wrong type
 * answers NULL, so a request raised under the other type's rules has no
 * content to clear.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantBill } from './r035-approval.helpers';
import { approvalTypeOf, cleanupPr3, noteCompany, plantNote, type NoteType } from './r035-pr3.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';
let other = '';

beforeAll(async () => {
  user = await createUser(pool, tokens);
  other = await createUser(pool, tokens);
});
afterAll(() => cleanupPr3(pool, companies, [user, other]));

const company = () => noteCompany(pool, [[user, 'owner'], [other, 'admin']], companies);

const digest = async (c: string, type: string, id: string) => (await pool.query(
  'SELECT approval_document_digest($1, $2, $3) AS d', [c, type, id])).rows[0].d as string | null;

/** Set one column of the note to a new value, read the digest, put the old value back. */
async function digestWith(c: string, type: NoteType, id: string, column: string, value: unknown): Promise<string | null> {
  const before = (await pool.query(`SELECT ${column} AS v FROM credit_notes WHERE id = $1`, [id])).rows[0].v;
  await pool.query(`UPDATE credit_notes SET ${column} = $2 WHERE id = $1`, [id, value]);
  const moved = await digest(c, approvalTypeOf(type), id);
  await pool.query(`UPDATE credit_notes SET ${column} = $2 WHERE id = $1`, [id, before]);
  return moved;
}

describe.each(['customer', 'supplier'] as const)('the %s credit note digest', (type) => {
  it('is a sha256 for its own type and NULL for the other type or another company', async () => {
    const c = await company();
    const note = await plantNote(pool, c, user, type);
    expect(await digest(c, approvalTypeOf(type), note.id)).toMatch(/^[0-9a-f]{64}$/);
    expect(await digest(c, approvalTypeOf(type === 'customer' ? 'supplier' : 'customer'), note.id)).toBeNull();
    expect(await digest(await company(), approvalTypeOf(type), note.id)).toBeNull();
    // The legacy type names no content: a credit_note request can clear nothing.
    expect(await digest(c, 'credit_note', note.id)).toBeNull();
  });

  it('moves with every hashed column', async () => {
    const c = await company();
    const note = await plantNote(pool, c, user, type, { linked: true });
    const base = await digest(c, approvalTypeOf(type), note.id);
    // credit_notes.project_id / cost_center_id carry no foreign key.
    const project = crypto.randomUUID();
    const center = crypto.randomUUID();
    const otherEntity = await plantNote(pool, c, user, type, { linked: true });
    const moves: [string, unknown][] = [
      ['credit_note_number', 'CN-MOVED'],
      ['credit_date', '2026-09-02'],
      ['currency', 'USD'],
      ['subtotal', 1001],
      ['tax_rate', 14],
      ['tax_amount', 151],
      ['total_amount', 1151],
      ['project_id', project],
      ['cost_center_id', center],
      [type === 'customer' ? 'client_id' : 'supplier_id', otherEntity.entityId],
      [type === 'customer' ? 'customer_invoice_id' : 'supplier_invoice_id', otherEntity.invoiceId],
    ];
    for (const [column, value] of moves) {
      expect(await digestWith(c, type, note.id, column, value), column).not.toBe(base);
    }
    // The other side's columns are hashed too: a note naming both cannot shed one.
    const crossColumn = type === 'customer' ? 'supplier_id' : 'client_id';
    const crossEntity = await plantNote(pool, c, user, type === 'customer' ? 'supplier' : 'customer');
    expect(await digestWith(c, type, note.id, crossColumn, crossEntity.entityId), crossColumn).not.toBe(base);
    expect(await digest(c, approvalTypeOf(type), note.id)).toBe(base);
  });

  it('does not move with what posting never reads', async () => {
    const c = await company();
    const note = await plantNote(pool, c, user, type);
    const base = await digest(c, approvalTypeOf(type), note.id);
    const still: [string, unknown][] = [
      ['reason', 'changed reason'],
      ['status', 'cancelled'],
      ['applied_amount', 10],
      ['approved_by', other],
      ['approved_at', '2026-09-03T00:00:00Z'],
      ['cancelled_by', other],
      ['cancelled_at', '2026-09-03T00:00:00Z'],
      ['cancel_reason', 'x'],
      ['external_ref', 'EXT-1'],
      ['external_document_number', 'EXT-DOC'],
      ['external_system', 'sage'],
      ['actor_type', 'agent'],
      ['actor_token_jti', 'jti-1'],
      ['created_at', '2026-01-01T00:00:00Z'],
      ['updated_at', '2026-01-01T00:00:00Z'],
      ['content_authors', [other]],
      ['content_edited_at', '2026-09-03T00:00:00Z'],
    ];
    for (const [column, value] of still) {
      expect(await digestWith(c, type, note.id, column, value), column).toBe(base);
    }
  });
});

describe('the supplier-invoice branches are unchanged', () => {
  const MIGRATIONS = path.resolve(__dirname, '../../scripts/migrations/sql');
  /** The function as an earlier migration defined it, re-created under a temporary name. */
  function asDefinedIn(file: string, fn: string, alias: string): string {
    const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
    const start = text.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
    const end = text.indexOf('$$;', start) + 3;
    expect(start, `${fn} in ${file}`).toBeGreaterThan(-1);
    return text.slice(start, end).replace(`public.${fn}(`, `pg_temp.${alias}(`);
  }

  // 862 against 708, not against the live function: 873 deliberately extends
  // the bill's digest with the CC1 / CC2 / BU line columns.
  it('a bill digests as 862 left 708\'s definition, and lists its authors exactly as 712 defined them', async () => {
    const c = await company();
    const bill = await plantBill(pool, c, user);
    await pool.query('UPDATE supplier_invoices SET content_authors = ARRAY[$2::UUID] WHERE id = $1', [bill.id, other]);
    const client = await pool.connect();
    try {
      await client.query(asDefinedIn('708_approval_enforcement_infra.sql', 'approval_document_digest', 'r035_digest_708'));
      await client.query(asDefinedIn('862_credit_note_approval_enforcement.sql', 'approval_document_digest', 'r035_digest_862'));
      await client.query(asDefinedIn('712_supplier_invoice_approval_enforcement.sql', 'approval_document_authors', 'r035_authors_712'));
      const { rows: [r] } = await client.query(
        `SELECT pg_temp.r035_digest_708($1,'supplier_invoice',$2) AS old_digest,
                pg_temp.r035_digest_862($1,'supplier_invoice',$2) AS new_digest,
                pg_temp.r035_authors_712($1,'supplier_invoice',$2)::TEXT AS old_authors,
                approval_document_authors($1,'supplier_invoice',$2)::TEXT AS new_authors`, [c, bill.id]);
      expect(r.old_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(r.new_digest).toBe(r.old_digest);
      expect(r.new_authors).toBe(r.old_authors);
      expect(r.new_authors).toContain(other);
    } finally {
      client.release();
    }
  });
});

describe.each(['customer', 'supplier'] as const)('the %s credit note authors', (type) => {
  it('are the creator plus every stamped editor, for the matching type only', async () => {
    const c = await company();
    const note = await plantNote(pool, c, user, type);
    await pool.query('UPDATE credit_notes SET content_authors = ARRAY[$2::UUID] WHERE id = $1', [note.id, other]);
    const authors = async (t: string) => (await pool.query(
      'SELECT approval_document_authors($1,$2,$3)::TEXT[] AS a', [c, t, note.id])).rows[0].a as string[] | null;
    expect((await authors(approvalTypeOf(type)))?.sort()).toEqual([user, other].sort());
    expect(await authors(approvalTypeOf(type === 'customer' ? 'supplier' : 'customer'))).toBeNull();
  });
});
