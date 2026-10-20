/**
 * R-035 PR3, decision Q6: an agent may neither raise nor decide an approval,
 * so the MCP credit-note approve tools refuse or skip a gated note — from a
 * READ, before anything is written.
 *
 *  - approve_credit_note answers a tool error carrying the gate's reason;
 *    nothing posts and the idempotency key stays free for the call that
 *    succeeds once a person has had it approved.
 *  - bulk_approve_credit_notes skips the gated note with an
 *    `approval_required: …` reason (the dry run already says so) and posts its
 *    ungated sibling, of the other type, in the same call.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '../../src/lib/als';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { approveCreditNoteTool } from '../../src/lib/mcp/tools/writeCreditNotes';
import { bulkApproveCreditNotesTool } from '../../src/lib/mcp/tools/writeBulkApproveCreditNotes';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { approvalTypeOf, cleanupPr3, enforceType, noteCompany, noteRoutes, noteState, plantNote } from './r035-pr3.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const r = noteRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr3(pool, companies, Object.values(u)));

async function asUser<T>(userId: string, companyId: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await als.run({ client, userId, companyId, claims: { sub: userId } } as never, fn);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const registry = new McpRegistry();
registry.register(approveCreditNoteTool);
registry.register(bulkApproveCreditNotesTool);
const mcp = (c: string, name: string, args: Record<string, unknown>) => asUser(u.a, c, () => registry.call(name, args,
  { userId: u.a, companyId: c, scopes: ['write:invoices', 'write:post'], companyRole: 'owner', tokenJti: 'r035-pr3', oauthAppId: null }));
const text = (res: { content: { text: string }[] }) => res.content[0]!.text;

/** A (admin) books; B (owner) approves. Owner rule on every note of `type`, enforced. */
async function fixture(type: 'customer' | 'supplier') {
  const c = await noteCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
  await plantRule(pool, c, 'owner', { documentType: approvalTypeOf(type) });
  await enforceType(pool, c, type, u.b);
  return { c, note: await plantNote(pool, c, u.a, type) };
}

async function approvedByB(c: string, type: 'customer' | 'supplier', noteId: string): Promise<void> {
  const raised = await r.raise(u.a, c, approvalTypeOf(type), noteId);
  expect(raised.state.statusCode).toBe(200);
  expect((await r.decide(pool, u.b, c, dataOf<{ id: string }>(raised).id)).state.statusCode).toBe(200);
}

describe.each(['customer', 'supplier'] as const)('approve_credit_note on a %s note', (type) => {
  it('refuses a gated note before writing, and leaves its idempotency key free', async () => {
    const { c, note } = await fixture(type);
    const key = `r035-pr3-${note.id}`;
    const refused = await mcp(c, 'approve_credit_note', { credit_note_id: note.id, idempotency_key: key });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/credit note CN-\S+ needs owner approval/);
    expect(text(refused)).toMatch(/cannot raise or decide approvals/);
    expect(await noteState(pool, note.id)).toMatchObject({ status: 'draft', gl_journal_entry_id: null, journals: 0 });
    const { rows } = await pool.query('SELECT count(*)::INT AS n FROM approval_requests WHERE document_id = $1', [note.id]);
    expect(rows[0].n).toBe(0);

    await approvedByB(c, type, note.id);
    const posted = await mcp(c, 'approve_credit_note', { credit_note_id: note.id, idempotency_key: key });
    expect(posted.isError, text(posted)).toBeFalsy();
    expect((await noteState(pool, note.id)).journals).toBe(1);
  });
});

describe('bulk_approve_credit_notes', () => {
  it('skips the gated note (approval_required) and posts its ungated sibling of the other type', async () => {
    const { c, note } = await fixture('customer');
    const ungated = await plantNote(pool, c, u.a, 'supplier');
    const ids = [note.id, ungated.id];
    const preview = await mcp(c, 'bulk_approve_credit_notes', { credit_note_ids: ids, dry_run: true, idempotency_key: `r035-pr3-dry-${note.id}` });
    expect(JSON.parse(text(preview))).toMatchObject({
      would_post_ids: [ungated.id],
      skipped: [expect.objectContaining({ document_id: note.id, reason: expect.stringMatching(/^approval_required: Customer credit note/) })],
    });
    const res = await mcp(c, 'bulk_approve_credit_notes', { credit_note_ids: ids, idempotency_key: `r035-pr3-bulk-${note.id}` });
    expect(res.isError, text(res)).toBeFalsy();
    const body = JSON.parse(text(res)) as { posted: number; skipped: { document_id: string; reason: string }[] };
    expect(body.posted).toBe(1);
    expect(body.skipped).toEqual([expect.objectContaining({ document_id: note.id, reason: expect.stringMatching(/^approval_required/) })]);
    expect((await noteState(pool, note.id)).journals).toBe(0);
    expect((await noteState(pool, ungated.id)).journals).toBe(1);
  });

  it('a batch whose every note is gated is refused before writing', async () => {
    const { c, note } = await fixture('supplier');
    const res = await mcp(c, 'bulk_approve_credit_notes', { credit_note_ids: [note.id], idempotency_key: `r035-pr3-none-${note.id}` });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/approval_required/);
    expect((await noteState(pool, note.id)).journals).toBe(0);
  });
});
