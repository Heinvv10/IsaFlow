// Migration 978: every automatic transfer link writes a bank_transfer_link_log row with the line's previous fields,
// and an undo puts the line back exactly, only while nothing has changed it since. The passes and the undo run as
// app_user inside a request transaction with the company's GUCs, as withAuth runs them, so the column grants, the
// guard trigger and the forced RLS policy are all on the path under test.
// Source: src/modules/accounting/services/bank/bankTransferLink{Passes,Service,Log,Undo}.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  autoLinkImportedBatchTransfers, relinkTransferCounterparts,
} from '@/modules/accounting/services/bank/bankTransferLinkService';
import { listTransferLinks, type TransferLinkTrigger } from '@/modules/accounting/services/bank/bankTransferLinkLog';
import { undoTransferLinks } from '@/modules/accounting/services/bank/bankTransferLinkUndo';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { AMOUNT, DAY, addSecondLegToJournal, cleanup, pageLoad, seedScenario } from './helpers/k019TransferFixture';
import { asApp, asOwner, lineFields, logRowsOf, seedTenants, undoErr } from './helpers/transferLinkLogHarness';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const user = crypto.randomUUID();
const otherUser = crypto.randomUUID();
const USER = { id: user, email: `${user}@test.local` };

const fields = (txId: string) => lineFields(pool, txId);
const logRows = (txId: string) => logRowsOf(pool, txId);
const inRequest = <T>(fn: () => Promise<T>, companyId = company, sub = user) => asApp(companyId, sub, () => fn());

beforeAll(async () => {
  assertNotProductionDb('This suite seeds companies and writes bank_transactions and bank_transfer_link_log rows.');
  await seedTenants(pool, { company, other, user, otherUser });
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1::uuid[])', [[company, other]]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1::uuid[])', [[company, other]]);
    await pool.query('DELETE FROM users WHERE id = $1', [otherUser]);
    await cleanup(pool, [company, other], user);
  } finally {
    await pool.end();
  }
});

describe('978 link writes its log row', () => {
  it('records the batch, the journal line, the previous fields and the updated_at the link left', async () => {
    const s = await seedScenario(pool, company, user, 1, 1);
    const trigger = pageLoad();
    const r = await inRequest(() => relinkTransferCounterparts(company, s.targetBank, trigger));
    expect(r).toMatchObject({ linked: 1, failed: false, batchId: trigger.linkBatchId });
    const [row] = await logRows(s.imported[0]);
    expect(row).toMatchObject({
      company_id: company, link_batch_id: trigger.linkBatchId, trigger_source: 'page_load', import_batch_id: null,
      bank_account_id: s.targetBank, journal_entry_id: s.journals[0], journal_line_id: s.freeLines[0],
      counterparty_account_id: s.sourceBanks[0], prev_status: 'imported', prev_allocation_type: null,
      prev_transfer_journal_entry_id: null, prev_matched_journal_line_id: null, prev_counterparty_account_id: null,
      prev_allocated_entity_name: null, prev_allocation_rule_id: null, prev_allocation_rule_name: null,
      linked_by: user, undone_at: null,
    });
    const same = await pool.query(
      `SELECT l.linked_row_updated_at = bt.updated_at AS same FROM bank_transfer_link_log l
         JOIN bank_transactions bt ON bt.id = l.bank_transaction_id WHERE l.id = $1`, [row.id]);
    expect(same.rows[0].same).toBe(true);
    const listed = await inRequest(() => listTransferLinks(company, s.targetBank));
    expect(listed.find((b) => b.batchId === trigger.linkBatchId)?.activeCount).toBe(1);
  });

  it('records an import as the import and its batch', async () => {
    // The import batch is a line's provenance, fixed at insert: the incoming line is born in the batch.
    const s = await seedScenario(pool, company, user, 1, 0);
    const importBatch = crypto.randomUUID();
    const incoming = crypto.randomUUID();
    await pool.query(
      `INSERT INTO bank_transactions(id,company_id,bank_account_id,import_batch_id,transaction_date,amount,description,status)
       VALUES($1,$2,$3,$4,DATE '${DAY}',${AMOUNT},'Import fixture','imported')`,
      [incoming, company, s.targetBank, importBatch]);
    s.imported.push(incoming);
    const trigger: TransferLinkTrigger = { source: 'import', linkBatchId: crypto.randomUUID(), importBatchId: importBatch };
    // The batch pass reads 'transfer' allocations; the fixture's source legs are.
    const r = await inRequest(() => autoLinkImportedBatchTransfers(company, importBatch, trigger));
    expect(r.linked).toBe(1);
    expect((await logRows(s.imported[0]))[0]).toMatchObject({ trigger_source: 'import', import_batch_id: importBatch });
  });

  it('rolls the link back when its log row cannot be written', async () => {
    const s = await seedScenario(pool, company, user, 1, 1);
    const r = await inRequest(() => relinkTransferCounterparts(company, s.targetBank,
      { source: 'x' as never, linkBatchId: crypto.randomUUID() }));
    expect(r).toMatchObject({ linked: 0, failed: true, batchId: null });
    expect((await fields(s.imported[0])).status).toBe('imported');
    expect(await logRows(s.imported[0])).toHaveLength(0);
  });
});

describe('978 undo', () => {
  it('per line: restores the exact previous fields, stamps the log once and writes the audit row', async () => {
    const s = await seedScenario(pool, company, user, 1, 1);
    const tx = s.imported[0];
    // Non-NULL previous values, so "exactly as before" is proven on values, not only on NULLs.
    await pool.query("UPDATE bank_transactions SET allocated_entity_name = 'Prior name', allocation_rule_name = 'Prior rule' WHERE id = $1", [tx]);
    const before = await fields(tx);
    await inRequest(() => relinkTransferCounterparts(company, s.targetBank, pageLoad()));
    expect((await fields(tx)).status).toBe('allocated');
    const [link] = await logRows(tx);

    expect(await inRequest(() => undoTransferLinks(company, { linkId: link.id }, USER))).toEqual({ undone: 1, refused: 0 });
    expect(await fields(tx)).toEqual(before);
    const [after] = await logRows(tx);
    expect(after.undone_at).not.toBeNull();
    expect(after.undone_by).toBe(user);
    const audit = await pool.query(
      "SELECT changes FROM audit_log WHERE company_id = $1 AND entity_type = 'bank_transaction' AND entity_id = $2", [company, tx]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].changes.metadata).toMatchObject({ source: 'transfer_link_undo', linkId: link.id });
    // Every restored field is in the audit row: the link's value as old, the value before the link as new.
    const byField = Object.fromEntries((audit.rows[0].changes.fields as Array<{ field: string; old: unknown; new: unknown }>)
      .map((f) => [f.field, f]));
    expect(Object.keys(byField)).toHaveLength(8);
    expect(byField.matched_journal_line_id).toMatchObject({ old: s.freeLines[0], new: null });
    expect(byField.transfer_journal_entry_id).toMatchObject({ old: s.journals[0], new: null });
    expect(byField.allocation_rule_name).toMatchObject({ old: null, new: 'Prior rule' });
    expect(byField.allocated_entity_name.new).toBe('Prior name');

    // A second undo of the same link finds nothing live.
    expect(await undoErr(inRequest(() => undoTransferLinks(company, { linkId: link.id }, USER)))).toBe('NOT_FOUND');
  });

  it('per batch: one undo restores every line of the batch', async () => {
    const s = await seedScenario(pool, company, user, 2, 2);
    const trigger = pageLoad();
    expect((await inRequest(() => relinkTransferCounterparts(company, s.targetBank, trigger))).linked).toBe(2);
    expect(await inRequest(() => undoTransferLinks(company, { batchId: trigger.linkBatchId }, USER))).toEqual({ undone: 2, refused: 0 });
    for (const tx of s.imported) expect((await fields(tx)).status).toBe('imported');
  });

  it('never relinks an undone pair, but the line may still link to another free leg', async () => {
    const s = await seedScenario(pool, company, user, 1, 1);
    const tx = s.imported[0];
    await inRequest(() => relinkTransferCounterparts(company, s.targetBank, pageLoad()));
    const [link] = await logRows(tx);
    await inRequest(() => undoTransferLinks(company, { linkId: link.id }, USER));

    expect((await inRequest(() => relinkTransferCounterparts(company, s.targetBank, pageLoad()))).linked).toBe(0);
    expect((await fields(tx)).status).toBe('imported');

    // A second leg on the same journal: the veto is per pair, so the line links to that leg.
    const secondLeg = await addSecondLegToJournal(pool, company, s.journals[0], s.targetBank);
    expect((await inRequest(() => relinkTransferCounterparts(company, s.targetBank, pageLoad()))).linked).toBe(1);
    expect((await fields(tx)).matched_journal_line_id).toBe(secondLeg);
  });

  it('a vetoed pair does not starve the next-best journal line in the same pass', async () => {
    // Two transfer journals, one statement line: the first link takes the lower line. Once undone, that pair must be
    // left out of the ranking, or it wins again, links nothing and ends the pass before the other line is tried.
    const s = await seedScenario(pool, company, user, 2, 1);
    const tx = s.imported[0];
    await inRequest(() => relinkTransferCounterparts(company, s.targetBank, pageLoad()));
    const [link] = await logRows(tx);
    expect(link.journal_line_id).toBe([...s.freeLines].sort()[0]);
    await inRequest(() => undoTransferLinks(company, { linkId: link.id }, USER));
    expect((await inRequest(() => relinkTransferCounterparts(company, s.targetBank, pageLoad()))).linked).toBe(1);
    expect((await fields(tx)).matched_journal_line_id).toBe([...s.freeLines].sort()[1]);
  });

  it('refuses after a later change to the line, and leaves the line and the log untouched', async () => {
    const s = await seedScenario(pool, company, user, 2, 2);
    await inRequest(() => relinkTransferCounterparts(company, s.targetBank, pageLoad()));
    const [a] = await logRows(s.imported[0]);
    const [b] = await logRows(s.imported[1]);

    await pool.query("UPDATE bank_transactions SET notes = 'edited later' WHERE id = $1", [s.imported[0]]);
    const changedA = await fields(s.imported[0]);
    expect(await undoErr(inRequest(() => undoTransferLinks(company, { linkId: a.id }, USER)))).toBe('CHANGED');
    expect(await fields(s.imported[0])).toEqual(changedA);
    expect((await logRows(s.imported[0]))[0].undone_at).toBeNull();

    await pool.query("UPDATE bank_transactions SET status = 'reconciled' WHERE id = $1", [s.imported[1]]);
    expect(await undoErr(inRequest(() => undoTransferLinks(company, { linkId: b.id }, USER)))).toBe('CHANGED');
    expect((await fields(s.imported[1])).status).toBe('reconciled');
  });

  it('undoes the unchanged lines of a batch and reports the changed one refused', async () => {
    const s = await seedScenario(pool, company, user, 2, 2);
    const trigger = pageLoad();
    await inRequest(() => relinkTransferCounterparts(company, s.targetBank, trigger));
    await pool.query("UPDATE bank_transactions SET notes = 'edited later' WHERE id = $1", [s.imported[0]]);
    expect(await inRequest(() => undoTransferLinks(company, { batchId: trigger.linkBatchId }, USER))).toEqual({ undone: 1, refused: 1 });
    expect((await fields(s.imported[0])).status).toBe('allocated');
    expect((await fields(s.imported[1])).status).toBe('imported');
  });

  it("refuses another tenant's undo and shows it nothing", async () => {
    const s = await seedScenario(pool, company, user, 1, 1);
    const trigger = pageLoad();
    await inRequest(() => relinkTransferCounterparts(company, s.targetBank, trigger));
    const [link] = await logRows(s.imported[0]);
    const OTHER = { id: otherUser };
    expect(await undoErr(inRequest(() => undoTransferLinks(other, { linkId: link.id }, OTHER), other, otherUser))).toBe('NOT_FOUND');
    expect(await undoErr(inRequest(() => undoTransferLinks(other, { batchId: trigger.linkBatchId }, OTHER), other, otherUser))).toBe('NOT_FOUND');
    expect(await inRequest(() => listTransferLinks(other, s.targetBank), other, otherUser)).toEqual([]);
    // Without RLS too: the service's own company_id scoping refuses it.
    expect(await undoErr(asOwner(other, otherUser, () => undoTransferLinks(other, { linkId: link.id }, OTHER)))).toBe('NOT_FOUND');
    expect(await undoErr(asOwner(other, otherUser, () => undoTransferLinks(other, { batchId: trigger.linkBatchId }, OTHER)))).toBe('NOT_FOUND');
    expect(await asOwner(other, otherUser, () => listTransferLinks(other, s.targetBank))).toEqual([]);
    expect((await fields(s.imported[0])).status).toBe('allocated');
    expect((await logRows(s.imported[0]))[0].undone_at).toBeNull();
  });

  it('lets a statement line be deleted, taking its log rows with it', async () => {
    const s = await seedScenario(pool, company, user, 1, 1);
    await inRequest(() => relinkTransferCounterparts(company, s.targetBank, pageLoad()));
    expect(await logRows(s.imported[0])).toHaveLength(1);
    await pool.query('DELETE FROM bank_transactions WHERE id = $1', [s.imported[0]]);
    expect(await logRows(s.imported[0])).toHaveLength(0);
  });
});
