/**
 * Budgets P5 T10 (spec §3e, §6 T10, §7), on real PostgreSQL as app_user under forced RLS: variance notes
 * are `report_commentary` rows of kind 'budget_variance'. Owner/admin/manager write a draft; only
 * owner/admin approve or reject; a variance approval takes no pack lock and no page-4 ems charge; the
 * generic pack approve/reject cannot touch a variance row; every id of another company reads as missing.
 * Seed: helpers/budgetTrackingFixture.ts (FY2027 = Mar 2026 - Apr 2027, primary 'Original').
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { sql, type DbRow } from '@/lib/neon';
import { approveCommentary, rejectCommentary } from '@/modules/accounting/services/commentary/commentaryService';
import { MAX_APPROVED_PACK_EMS, MAX_UNBUDGETED_CHARS, commentaryCost } from '@/modules/accounting/services/commentary/commentaryLimits';
import {
  approveVarianceNote, listVarianceNotes, rejectVarianceNote, saveVarianceNote, type SaveVarianceNoteInput,
} from '@/modules/accounting/services/commentary/varianceCommentary';
import { varianceParamsHash } from '@/modules/accounting/services/reports/varianceParamsHash';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRequest, dropTrackingFixture, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;
const people = { admin: crypto.randomUUID(), manager: crypto.randomUUID(), viewer: crypto.randomUUID() };
const MONTH = '2026-06';

beforeAll(async () => {
  f = await seedTrackingFixture(pool);
  for (const [role, id] of Object.entries(people)) {
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [id, `${id}@test.local`]);
    await pool.query('INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, $3)', [f.a, id, role]);
  }
  // A's owner is also a member of B, so RLS (company_id IN the user's companies) lets B's rows through:
  // only the services' own company_id predicates keep B's ids out of A's request.
  await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'viewer')", [f.b, f.userA]);
}, 120_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM report_commentary WHERE company_id = ANY($1::UUID[])', [[f.a, f.b]]);
    await pool.query('DELETE FROM company_users WHERE user_id = ANY($1::TEXT[])', [Object.values(people)]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::TEXT[])', [Object.values(people)]);
    await dropTrackingFixture(pool, f);
  } finally { await pool.end(); }
});

const owner = () => ({ userId: f.userA, role: 'owner' });
const admin = { userId: people.admin, role: 'admin' };
const manager = { userId: people.manager, role: 'manager' };
const viewer = { userId: people.viewer, role: 'viewer' };
const asA = <T>(fn: () => Promise<T>, before?: (c: PoolClient) => Promise<unknown>) =>
  asRequest(pool, f.a, f.userA, fn, { appUser: true, before });
const input = (text: string, over: Partial<SaveVarianceNoteInput> = {}): SaveVarianceNoteInput => ({
  versionId: f.v.primary27, month: MONTH, glAccountId: f.acc.opex, cc1Id: null, cc2Id: null, buId: null, text, ...over,
});
async function rowOf(id: string): Promise<DbRow> {
  return ((await sql`SELECT * FROM report_commentary WHERE id = ${id}::UUID`) as DbRow[])[0]!;
}
/** Prose costing about `share` of the board pack's page-4 budget. */
function sized(share: number, seed: string): string {
  const sentence = `${seed} spend ran over because the second site opened early and the contractor billed in advance. `;
  let out = '';
  while (commentaryCost([out + sentence]) <= MAX_APPROVED_PACK_EMS * share) out += sentence;
  return out.trim();
}

describe('roles: write, approve, reject', () => {
  it('a manager writes a draft; a viewer does not see it; a manager cannot approve; an owner can; then every member reads the approved text', async () => {
    await asA(async () => {
      const saved = await saveVarianceNote(f.a, manager, input('Rent rose with the new lease.'));
      expect(saved).toMatchObject({ ok: true, note: { status: 'draft', draftText: 'Rent rose with the new lease.', glAccountId: f.acc.opex } });
      if (!saved.ok) return;
      const stored = await rowOf(saved.note.id);
      expect(stored).toMatchObject({ report_kind: 'budget_variance', section_ref: 'account', generated_by: `human:${people.manager}`,
        params_hash: varianceParamsHash(f.v.primary27, MONTH), row_ref: `${f.acc.opex}|||` });
      expect([stored.period_start, stored.period_end].map((d) => new Date(d as string).toISOString().slice(0, 10)))
        .toEqual(['2026-06-01', '2026-06-30']);

      expect(await listVarianceNotes(f.a, 'viewer', f.v.primary27, MONTH)).toEqual({ ok: true, notes: [] });
      const mine = await listVarianceNotes(f.a, 'manager', f.v.primary27, MONTH);
      expect(mine.ok && mine.notes.map((n) => [n.status, n.draftText])).toEqual([['draft', 'Rent rose with the new lease.']]);

      expect(await approveVarianceNote(f.a, manager, saved.note.id, 'Rent rose with the new lease.')).toMatchObject({ ok: false, code: 'forbidden' });
      expect(await approveVarianceNote(f.a, viewer, saved.note.id, 'Rent rose with the new lease.')).toMatchObject({ ok: false, code: 'forbidden' });
      expect((await rowOf(saved.note.id)).status).toBe('draft');

      const approved = await approveVarianceNote(f.a, owner(), saved.note.id, 'Rent rose with the new lease.');
      expect(approved).toMatchObject({ ok: true, note: { status: 'approved', approvedText: 'Rent rose with the new lease.', approvedBy: f.userA } });
      const seen = await listVarianceNotes(f.a, 'viewer', f.v.primary27, MONTH);
      expect(seen.ok && seen.notes).toEqual([expect.objectContaining({
        status: 'approved', approvedText: 'Rent rose with the new lease.', draftText: null })]);
    });
  });

  it('a viewer cannot write; a manager cannot reject; an admin can; the manager may then revive the rejected note', async () => {
    await asA(async () => {
      expect(await saveVarianceNote(f.a, viewer, input('x'))).toMatchObject({ ok: false, code: 'forbidden' });
      const saved = await saveVarianceNote(f.a, manager, input('First draft.'));
      if (!saved.ok) throw new Error(saved.reason);
      expect(await rejectVarianceNote(f.a, manager, saved.note.id, 'First draft.')).toMatchObject({ ok: false, code: 'forbidden' });
      expect(await rejectVarianceNote(f.a, admin, saved.note.id, 'First draft.')).toMatchObject({ ok: true, note: { status: 'rejected' } });
      expect(await listVarianceNotes(f.a, 'viewer', f.v.primary27, MONTH)).toEqual({ ok: true, notes: [] });
      expect(await saveVarianceNote(f.a, manager, input('Second draft.'))).toMatchObject({ ok: true, note: { id: saved.note.id, status: 'draft' } });
    });
  });

  it('an approved note: a manager cannot re-draft it; an admin can, and the approval is stamped withdrawn, not erased', async () => {
    await asA(async () => {
      const saved = await saveVarianceNote(f.a, manager, input('Approved wording.'));
      if (!saved.ok) throw new Error(saved.reason);
      expect((await approveVarianceNote(f.a, owner(), saved.note.id, 'Approved wording.')).ok).toBe(true);
      expect(await saveVarianceNote(f.a, manager, input('Manager rewrite.'))).toMatchObject({ ok: false, code: 'invalid_state' });
      expect((await rowOf(saved.note.id)).status).toBe('approved');
      expect(await saveVarianceNote(f.a, admin, input('Admin rewrite.'))).toMatchObject({ ok: true, note: { status: 'draft' } });
      expect(await rowOf(saved.note.id)).toMatchObject({ status: 'draft', draft_text: 'Admin rewrite.', withdrawn_by: people.admin,
        approved_text: 'Approved wording.', approved_by: f.userA });
    });
  });

  it('refuses blank, unstorable and over-long text before anything is written', async () => {
    await asA(async () => {
      expect(await saveVarianceNote(f.a, owner(), input(' ​ '))).toMatchObject({ ok: false, code: 'empty_draft' });
      expect(await saveVarianceNote(f.a, owner(), input('a\u0000b'))).toMatchObject({ ok: false, code: 'invalid_text' });
      expect(await saveVarianceNote(f.a, owner(), input('x'.repeat(MAX_UNBUDGETED_CHARS + 1)))).toMatchObject({ ok: false, code: 'text_too_long' });
      expect(((await sql`SELECT COUNT(*)::INT n FROM report_commentary WHERE company_id = ${f.a}::UUID`) as DbRow[])[0]!.n).toBe(0);
    });
  });
});

describe('an approver signs only the text they were shown', () => {
  it('a note re-drafted between the approver\'s load and the click is refused (409) and nothing is approved', async () => {
    await asA(async () => {
      const saved = await saveVarianceNote(f.a, manager, input('What the owner read.'));
      if (!saved.ok) throw new Error(saved.reason);
      const seen = saved.note.draftText!;
      expect((await saveVarianceNote(f.a, manager, input('Swapped in after the owner opened it.'))).ok).toBe(true);
      expect(await approveVarianceNote(f.a, owner(), saved.note.id, seen)).toMatchObject({ ok: false, code: 'invalid_state' });
      expect(await approveVarianceNote(f.a, owner(), saved.note.id, seen, 'Owner wording.')).toMatchObject({ ok: false, code: 'invalid_state' });
      expect(await rowOf(saved.note.id)).toMatchObject({ status: 'draft', approved_text: null, draft_text: 'Swapped in after the owner opened it.' });
      expect(await approveVarianceNote(f.a, owner(), saved.note.id, 'Swapped in after the owner opened it.'))
        .toMatchObject({ ok: true, note: { approvedText: 'Swapped in after the owner opened it.' } });
    });
  });

  it('a reject of a note re-drafted since it was shown is refused (409) too, and the note stays a draft', async () => {
    await asA(async () => {
      const saved = await saveVarianceNote(f.a, manager, input('Shown to the admin.'));
      if (!saved.ok) throw new Error(saved.reason);
      expect((await saveVarianceNote(f.a, manager, input('Rewritten after.'))).ok).toBe(true);
      expect(await rejectVarianceNote(f.a, admin, saved.note.id, 'Shown to the admin.')).toMatchObject({ ok: false, code: 'invalid_state' });
      expect(await rowOf(saved.note.id)).toMatchObject({ status: 'draft', draft_text: 'Rewritten after.' });
      expect(await rejectVarianceNote(f.a, admin, saved.note.id, 'Rewritten after.')).toMatchObject({ ok: true, note: { status: 'rejected' } });
    });
  });
});

describe('a variance approval is not a board-pack approval', () => {
  it('takes no pack lock and no page-4 ems charge: two notes each larger than the whole page-4 budget both approve', async () => {
    const big = [sized(1.6, 'Opex'), sized(1.6, 'Sales')];
    expect(commentaryCost([big[0]!])).toBeGreaterThan(MAX_APPROVED_PACK_EMS);
    expect(big.every((t) => t.length <= MAX_UNBUDGETED_CHARS)).toBe(true);
    await asA(async () => {
      const a = await saveVarianceNote(f.a, owner(), input(big[0]!));
      const b = await saveVarianceNote(f.a, owner(), input('short', { glAccountId: f.acc.sales, cc2Id: f.cc.P1 }));
      if (!a.ok || !b.ok) throw new Error('save failed');
      const small = await saveVarianceNote(f.a, owner(), input('Interest was lower.', { glAccountId: f.acc.interest, buId: f.bu.B1 }));
      if (!small.ok) throw new Error(small.reason);
      // The small one first: as a board row it would fit the page and take the pack lock.
      const tiny = await approveVarianceNote(f.a, owner(), small.note.id, 'Interest was lower.');
      const plain = await approveVarianceNote(f.a, owner(), a.note.id, big[0]!);
      const edited = await approveVarianceNote(f.a, owner(), b.note.id, 'short', big[1]!);
      expect([tiny.ok, plain.ok, edited.ok]).toEqual([true, true, true]);
      // commentaryBudget.lockAndReadPack's pg_advisory_xact_lock(…, 611) is the pack lock: none is held.
      const locks = (await sql`SELECT COUNT(*)::INT n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`) as DbRow[];
      expect(locks[0]!.n).toBe(0);
    });
  });
});

describe('the generic pack commentary approve / reject cannot act on a variance row (census T1.3)', () => {
  it('answers not_found and leaves the row a draft, for any role the pack routes allow', async () => {
    await asA(async () => {
      const saved = await saveVarianceNote(f.a, manager, input('Pack route must not reach this.'));
      if (!saved.ok) throw new Error(saved.reason);
      expect(await approveCommentary(f.a, saved.note.id, f.userA)).toMatchObject({ ok: false, code: 'not_found' });
      expect(await approveCommentary(f.a, saved.note.id, f.userA, 'edited')).toMatchObject({ ok: false, code: 'not_found' });
      expect(await rejectCommentary(f.a, saved.note.id, people.manager)).toMatchObject({ ok: false, code: 'not_found' });
      expect((await rowOf(saved.note.id)).status).toBe('draft');
    });
  });

  it('nor can the variance service act on a pack row', async () => {
    const pack = crypto.randomUUID();
    await asA(async () => {
      expect(await approveVarianceNote(f.a, owner(), pack, 'pack draft')).toMatchObject({ ok: false, code: 'not_found' });
      expect(await rejectVarianceNote(f.a, owner(), pack, 'pack draft')).toMatchObject({ ok: false, code: 'not_found' });
      expect((await rowOf(pack)).status).toBe('draft');
    }, (c) => c.query(`INSERT INTO report_commentary (id, company_id, report_kind, params_hash, period_start, period_end, section_ref,
      row_ref, draft_text, generated_by) VALUES ($1, $2, 'pack', 'p', '2026-06-01', '2026-06-30', 'income_statement', 'revenue', 'pack draft', 'u')`,
    [pack, f.a]));
  });
});

describe('every id is the company\'s', () => {
  it('another company\'s version, account, centre or unit reads as missing; a wrong level or a month outside the year is a 400', async () => {
    await asA(async () => {
      const save = (over: Partial<SaveVarianceNoteInput>) => saveVarianceNote(f.a, owner(), input('x', over));
      expect(await save({ versionId: f.v.b27 })).toMatchObject({ ok: false, code: 'not_found' });
      expect(await save({ glAccountId: f.acc.bSales })).toMatchObject({ ok: false, code: 'not_found' });
      expect(await save({ cc1Id: f.cc.BX })).toMatchObject({ ok: false, code: 'not_found' });
      expect(await save({ buId: f.bu.BBX })).toMatchObject({ ok: false, code: 'not_found' });
      expect(await save({ versionId: crypto.randomUUID() })).toMatchObject({ ok: false, code: 'not_found' });
      expect(await save({ cc1Id: f.cc.P1 })).toMatchObject({ ok: false, code: 'bad_request' }); // P1 is a CC2
      expect(await save({ glAccountId: f.acc.bank })).toMatchObject({ ok: false, code: 'bad_request' });
      expect(await save({ month: '2027-06' })).toMatchObject({ ok: false, code: 'bad_request' }); // FY2028's month
      expect(await save({ month: '2026-13' })).toMatchObject({ ok: false, code: 'bad_request' });
      expect(await listVarianceNotes(f.a, 'owner', f.v.b27, MONTH)).toMatchObject({ ok: false, code: 'not_found' });
      expect(((await sql`SELECT COUNT(*)::INT n FROM report_commentary WHERE company_id = ${f.a}::UUID`) as DbRow[])[0]!.n).toBe(0);
    });
  });

  it('another company\'s note id cannot be approved or rejected, and its notes are never listed', async () => {
    const theirs = crypto.randomUUID();
    await asA(async () => {
      expect(await approveVarianceNote(f.a, owner(), theirs, 'B SECRET')).toMatchObject({ ok: false, code: 'not_found' });
      expect(await rejectVarianceNote(f.a, owner(), theirs, 'B SECRET')).toMatchObject({ ok: false, code: 'not_found' });
      const listed = await listVarianceNotes(f.a, 'owner', f.v.primary27, MONTH);
      expect(listed).toEqual({ ok: true, notes: [] });
    }, (c) => c.query(`INSERT INTO report_commentary (id, company_id, report_kind, params_hash, period_start, period_end, section_ref,
      row_ref, draft_text, generated_by) VALUES ($1, $2, 'budget_variance', $3, '2026-06-01', '2026-06-30', 'account', $4, 'B SECRET', 'u')`,
    [theirs, f.b, varianceParamsHash(f.v.primary27, MONTH), `${f.acc.bSales}|||`]));
    expect((await pool.query('SELECT COUNT(*)::INT n FROM report_commentary WHERE id = $1', [theirs])).rows[0].n).toBe(0); // rolled back
  });
});
