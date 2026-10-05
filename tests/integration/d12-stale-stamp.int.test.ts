/**
 * D12 census row 11: a line carrying a COMPLETED session's id while 'imported' / 'allocated' / 'provisional' is a
 * STALE stamp — not in the session. A write that turns it 'matched' OUTSIDE a session left it 'matched' under the
 * completed session on ddc4dd355, i.e. ADDED it to the signed-off reconciliation (reconciledCash then reads it as held
 * by that session). Every such writer now clears a stamp whose session is not in progress, in the same UPDATE, through
 * ONE fragment (`openStampOnly`); an IN-PROGRESS session's stamp is kept.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import provisionalAttach from '../../pages/api/accounting/provisional/[jeId]/attach';
import { attachEvidenceToProvisional } from '@/modules/accounting/services/capture/evidenceAttachmentService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras, setupWithUser } from './d10-helpers';
import {
  call, cleanup, completedInvariant, completedSession, lineOf, newBank, newId, routes, seedJournal, seedPair,
  startSession, type Route,
} from './d12-helpers';

let c: Ctx;
let token = '';
type Row = Record<string, unknown>;

/** A provisional journal X (posted, needs evidence) booking `line` (made 'provisional', linked to X) on `bank`. */
async function makeProvisional(bank: string, line: string, total: number, date: string): Promise<string> {
  const [x] = (await sql`INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by,
      posting_agent, needs_evidence)
    VALUES (${c.fx.companyId}::UUID, ${date}::DATE, 'D12 provisional', 'auto_bank_recon', 'draft', ${c.fx.userId}::UUID,
      'ai-provisional:v1', true) RETURNING id`) as Row[];
  await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES (${c.fx.companyId}::UUID, ${x!.id}::UUID, ${c.acct.expense}::UUID, ${total}, 0, 'D12 provisional'),
           (${c.fx.companyId}::UUID, ${x!.id}::UUID, ${bank}::UUID, 0, ${total}, 'D12 provisional')`;
  await sql`UPDATE gl_journal_entries SET status = 'posted', posted_at = NOW() WHERE id = ${x!.id}::UUID`;
  await sql`UPDATE bank_transactions SET status = 'provisional', provisional_je_id = ${x!.id}::UUID WHERE id = ${line}::UUID`;
  return String(x!.id);
}
async function newDoc(): Promise<string> {
  const id = newId();
  await sql`INSERT INTO captured_documents (id, company_id, file_name, file_type, document_type, extracted_data, status)
    VALUES (${id}::UUID, ${c.fx.companyId}::UUID, ${`d12-${id}.pdf`}, 'application/pdf', 'invoice', '{}'::jsonb, 'pending')`;
  return id;
}

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('D12 row 11: stale stamps are cleared, never joined', () => {
  beforeAll(async () => {
    assertNotProductionDb('D12 stale');
    ({ c, token } = await setupWithUser('D12S'));
  }, 120000);
  afterAll(async () => {
    await sql`UPDATE bank_transactions SET provisional_je_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
    await cleanup(c); await clearExtras(c); await teardown(c);
  }, 120000);

  /** `write(line)` turns the stale line 'matched'; it must end matched with NO stamp, the session unchanged. */
  async function detaches(write: (s: { bank: string; rec: string }, line: string) => Promise<{ status: number; body: string }>) {
    const s = await completedSession(c, token, { matched: 1, stale: 1 });
    const line = s.stale[0]!;
    expect(await lineOf(line)).toMatchObject({ status: 'imported', rec: s.rec });
    const out = await write(s, line);
    expect(out.status, JSON.stringify(out)).toBe(200);
    expect(await lineOf(line)).toMatchObject({ status: 'matched', rec: null });
    expect(await completedInvariant(c, s.bank, s.rec)).toBeNull();
  }

  it('match with no session named', () => detaches(async (s, line) => call(c, token, routes.tx,
    { action: 'match', bankTransactionId: line, journalLineId: await seedJournal(c, s.bank, 300) })), 60000);

  it('auto_match with no session named', () => detaches(async (s) => {
    await seedJournal(c, s.bank, 300, '2026-06-11');
    return call(c, token, routes.tx, { action: 'auto_match', bankAccountId: s.bank });
  }), 60000);

  it('bulk_accept', () => detaches((_s, line) => call(c, token, routes.tx, { action: 'bulk_accept', bankTransactionIds: [line] })), 60000);

  // bank-match-asset and bank-match-fleet no longer turn a line `matched` (mig 853: a link is an annotation), so they
  // carry no stale-stamp fragment; d12-r2-links pins that they leave the stamp and status alone.

  it('manual evidence attach (POST provisional/[jeId]/attach)', () => detaches(async (s, line) => {
    const x = await makeProvisional(s.bank, line, 300, '2026-06-11');
    return call(c, token, provisionalAttach as Route, { capturedDocumentId: await newDoc() }, { jeId: x });
  }), 60000);

  it('automatic evidence attach (attachEvidenceToProvisional, the capture follow-up)', () => detaches(async (s, line) => {
    await makeProvisional(s.bank, line, 300, '2026-06-11');
    const doc = await newDoc();
    const r = await inTx(c.fx, () => attachEvidenceToProvisional(c.fx.companyId, doc, null, 300, '2026-06-11'));
    return { status: r.attachedJeId ? 200 : 404, body: JSON.stringify(r) };
  }), 60000);

  it('an IN-PROGRESS session\'s stamp is kept: match with no session named leaves the line in that session', async () => {
    const bank = await newBank(c);
    const p = await seedPair(c, bank, 377.77, '2026-06-07');
    const rec = await startSession(c, token, bank);
    expect(await lineOf(p.bt)).toMatchObject({ status: 'imported', rec });
    const out = await call(c, token, routes.tx, { action: 'match', bankTransactionId: p.bt, journalLineId: p.jl });
    expect(out.status, JSON.stringify(out)).toBe(200);
    expect(await lineOf(p.bt)).toMatchObject({ status: 'matched', rec });
  }, 60000);
});
