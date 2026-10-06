/**
 * R-035 PR3: the database backstop on credit_notes (migration 862,
 * trg_credit_note_approval_gate), and the amount a credit-note rule sees.
 *
 * With enforcement on for the note's type and a rule matching it, a note may
 * not leave draft (or cancelled) for any posted status — by INSERT or UPDATE,
 * as app_user or as the owner role a script runs as — without an APPROVED
 * request for its CURRENT content decided since enforcement was switched on.
 * Draft → cancelled always passes. The import GUC does NOT: no importer writes
 * credit notes, so the credit-note backstop honours no exemption (review A2).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule } from './r035-approval.helpers';
import {
  approvalTypeOf, cleanupPr3, enforceType, noteCompany, plantNote, type Note, type NoteType,
} from './r035-pr3.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let owner = '';
let other = '';

beforeAll(async () => {
  owner = await createUser(pool, tokens);
  other = await createUser(pool, tokens);
});
afterAll(() => cleanupPr3(pool, companies, [owner, other]));

async function gated(type: NoteType, opts: { enforced?: boolean } = {}): Promise<{ c: string; note: Note }> {
  const c = await noteCompany(pool, [[owner, 'owner'], [other, 'owner']], companies);
  await plantRule(pool, c, 'owner', { documentType: approvalTypeOf(type) });
  if (opts.enforced !== false) await enforceType(pool, c, type, owner);
  return { c, note: await plantNote(pool, c, owner, type) };
}

async function asAppUser<T>(companyId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: owner, role: 'authenticated' })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const approveRaw = (client: PoolClient | Pool, id: string, status = 'approved') =>
  client.query('UPDATE credit_notes SET status = $2 WHERE id = $1', [id, status]);
const statusOf = async (id: string) =>
  (await pool.query('SELECT status FROM credit_notes WHERE id = $1', [id])).rows[0]?.status as string;

async function approvedRequest(c: string, note: Note, digest: 'current' | 'other' = 'current'): Promise<void> {
  await pool.query(
    `INSERT INTO approval_requests(company_id, document_type, document_id, status, requested_by, required_role,
       decided_by, decided_at, document_digest)
     VALUES($1,$2,$3,'approved',$4,'owner',$5, now(),
            CASE $6 WHEN 'current' THEN approval_document_digest($1,$2,$3) ELSE md5('x') END)`,
    [c, approvalTypeOf(note.type), note.id, other, owner, digest]);
}

describe.each(['customer', 'supplier'] as const)('the %s credit note backstop', (type) => {
  it("raw UPDATE to 'approved' as app_user raises, and the note stays a draft", async () => {
    const { c, note } = await gated(type);
    await expect(asAppUser(c, (client) => approveRaw(client, note.id))).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
    expect(await statusOf(note.id)).toBe('draft');
  });

  it('the owner role (an offline script) is held to it, for every posted status', async () => {
    const { note } = await gated(type);
    for (const status of ['approved', 'partially_applied', 'applied']) {
      await expect(approveRaw(pool, note.id, status), status).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
    }
  });

  it("raw INSERT as 'approved' raises", async () => {
    const { c, note } = await gated(type);
    await expect(asAppUser(c, (client) => client.query(
      `INSERT INTO credit_notes(company_id,type,client_id,supplier_id,credit_date,subtotal,tax_amount,total_amount,status,created_by)
       VALUES($1,$2,$3,$4,DATE '2026-09-01',100,15,115,'approved',$5)`,
      [c, type, type === 'customer' ? note.entityId : null, type === 'supplier' ? note.entityId : null, owner])))
      .rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });

  it('a cancelled note may not be revived straight into a posted status', async () => {
    const { note } = await gated(type);
    await approveRaw(pool, note.id, 'cancelled');
    await expect(approveRaw(pool, note.id)).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });

  it('an approval for different content, or for the other type, does not clear it', async () => {
    const { c, note } = await gated(type);
    await approvedRequest(c, note, 'other');
    await pool.query(
      `INSERT INTO approval_requests(company_id, document_type, document_id, status, requested_by, required_role,
         decided_by, decided_at, document_digest)
       VALUES($1,$2,$3,'approved',$4,'owner',$5, now(), approval_document_digest($1,$6,$3))`,
      [c, approvalTypeOf(type === 'customer' ? 'supplier' : 'customer'), note.id, other, owner, approvalTypeOf(type)]);
    await expect(approveRaw(pool, note.id)).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });

  it('changing the content in the same UPDATE as the status is judged on the NEW content', async () => {
    const { c, note } = await gated(type);
    await approvedRequest(c, note);
    await expect(pool.query(
      "UPDATE credit_notes SET status = 'approved', total_amount = 9999 WHERE id = $1", [note.id]))
      .rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });

  it('lets through: a cleared approval; draft → cancelled; enforcement off', async () => {
    const cleared = await gated(type);
    await approvedRequest(cleared.c, cleared.note);
    await approveRaw(pool, cleared.note.id);
    expect(await statusOf(cleared.note.id)).toBe('approved');

    const cancelled = await gated(type);
    await approveRaw(pool, cancelled.note.id, 'cancelled');
    expect(await statusOf(cancelled.note.id)).toBe('cancelled');

    const off = await gated(type, { enforced: false });
    await approveRaw(pool, off.note.id);
    expect(await statusOf(off.note.id)).toBe('approved');

  });

  it('the import GUC exempts nothing: no importer writes credit notes (review A2)', async () => {
    const imported = await gated(type);
    await expect(asAppUser(imported.c, async (client) => {
      await client.query("SELECT set_config('isaflow.approval_gate_exempt', 'import', true)");
      await approveRaw(client, imported.note.id);
    })).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
    expect(await statusOf(imported.note.id)).toBe('draft');
  });

  it('enforcement on for the OTHER type only does not hold this note', async () => {
    const c = await noteCompany(pool, [[owner, 'owner'], [other, 'owner']], companies);
    const otherType = type === 'customer' ? 'supplier' : 'customer';
    await plantRule(pool, c, 'owner', { documentType: approvalTypeOf(type) });
    await plantRule(pool, c, 'owner', { documentType: approvalTypeOf(otherType) });
    await enforceType(pool, c, otherType, owner);
    const note = await plantNote(pool, c, owner, type);
    await approveRaw(pool, note.id);
    expect(await statusOf(note.id)).toBe('approved');
  });
});

describe('the amount a credit-note rule sees (approval_credit_note_gate_amount)', () => {
  const amount = async (total: number | null, subtotal: number | null, tax: number | null) => Number((await pool.query(
    'SELECT approval_credit_note_gate_amount($1, $2, $3) AS a', [total, subtotal, tax])).rows[0].a);

  it('is the larger of the total and subtotal + tax, each taken absolute', async () => {
    expect(await amount(1150, 1000, 150)).toBe(1150);
    expect(await amount(100, 1000, 150)).toBe(1150);
    expect(await amount(5000, 1000, 150)).toBe(5000);
    expect(await amount(-5000, 1000, 150)).toBe(5000);
    expect(await amount(100, -1000, -150)).toBe(1150);
    expect(await amount(null, null, null)).toBe(0);
  });

  it('the backstop matches a note whose legs exceed its total on the larger figure', async () => {
    const c = await noteCompany(pool, [[owner, 'owner'], [other, 'owner']], companies);
    await plantRule(pool, c, 'owner', { documentType: 'supplier_credit_note', operator: 'greater_than', value: 1000 });
    await enforceType(pool, c, 'supplier', owner);
    const note = await plantNote(pool, c, owner, 'supplier', { subtotal: 1000, tax: 150, total: 100 });
    await expect(approveRaw(pool, note.id)).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
    const small = await plantNote(pool, c, owner, 'supplier', { subtotal: 800, tax: 120, total: 920 });
    await approveRaw(pool, small.id);
    expect(await statusOf(small.id)).toBe('approved');
  });
});
