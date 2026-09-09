import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { fixtureConfigFromEnv } from '../../../scripts/forensic/fixture-bootstrap';
import { provisionForensicFixture, validateFixtureTarget, type ForensicFixture } from '../forensic-fixture';
import { seedApAccounts } from './apSyntheticAccounts';
import { withControlRequest, requireControlTx } from '@/modules/accounting/services/controls/context';
import { requestOperationApproval, decideOperationApproval } from '@/modules/accounting/services/controls/approvalRequestService';
import { closePeriod, lockPeriod, reopenPeriod, closeYear } from '@/modules/accounting/services/gl/fiscalPeriodService';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { updateCompany, requestLockdownChange } from '@/modules/accounting/services/core/companyService';
import { lockVatPeriod } from '@/modules/accounting/services/reports/vatPeriodLockService';
import type { ControlTx, OperationRef } from '@/modules/accounting/services/controls/contracts';
const config = fixtureConfigFromEnv(process.env), target = validateFixtureTarget(config);
const pool = new Pool({ connectionString: target.connectionString, ssl: false, max: 5 });
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.CONTROL_FINGERPRINT_KEY = randomBytes(32).toString('hex');
let fixture: ForensicFixture, accounts: Awaited<ReturnType<typeof seedApAccounts>>, year = 2030;
beforeAll(async () => {
  fixture = await provisionForensicFixture(config); accounts = await seedApAccounts(pool, fixture.companyA);
  for (const type of ['fiscal_period', 'fiscal_year', 'company_lockdown', 'vat_period']) await pool.query(`
    INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role)
    VALUES($1,$2,'Synthetic lock policy',$3,'amount','any',0,'admin')`, [randomUUID(), fixture.companyA, type]);
});
afterAll(async () => { await pool.end(); });
async function actor<T>(person: 'u1' | 'u2' | 'u3', action: (ctx: ControlTx) => Promise<T>, label = 'synthetic-period') {
  const user = fixture[person], client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true),set_config('application_name',$3,true)",
      [JSON.stringify({ sub: user.id, role: 'authenticated', company_id: user.companyId }), user.companyId, label]);
    const result = await withControlRequest({ client, userId: user.id, companyId: user.companyId, claims: {} },
      { personId: user.id, companyId: user.companyId, authMethod: 'cookie' }, () => action(requireControlTx()));
    await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function period(status = 'open', fiscalYear = year++, number = 1) {
  const id = randomUUID(), start = `${fiscalYear}-${String(number).padStart(2,'0')}-01`;
  const end = `${fiscalYear}-${String(number).padStart(2,'0')}-28`;
  await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
    VALUES($1,$2,'Synthetic period',$3,$4,$5,$6,$7)`, [id, fixture.companyA, number, fiscalYear, start, end, status]);
  return { id, fiscalYear, start, end };
}
const ref = (id: string, operation: OperationRef['operation'] = 'fiscal_period.close'): OperationRef => ({ entityType: 'fiscal_period', entityId: id, operation });
async function approval(operation: OperationRef) {
  const row = await actor('u1', ctx => requestOperationApproval(ctx, operation));
  await actor('u2', ctx => decideOperationApproval(ctx, row.id, 'approved')); return row.id;
}
const state = async (id: string) => (await pool.query('SELECT status FROM fiscal_periods WHERE company_id=$1 AND id=$2', [fixture.companyA, id])).rows[0].status;
it('all fiscal transitions require independent approval and preserve tenant ownership', async () => {
  const open = await period(), closed = await period('closed');
  for (const operation of [() => closePeriod(fixture.companyA, open.id, fixture.u1.id),
    () => lockPeriod(fixture.companyA, closed.id), () => reopenPeriod(fixture.companyA, closed.id),
    () => closeYear(fixture.companyA, open.fiscalYear, fixture.u1.id)]) await expect(actor<unknown>('u1', operation)).rejects.toThrow('approval');
  await expect(actor('u3', () => closePeriod(fixture.companyA, open.id, fixture.u3.id))).rejects.toThrow();
  expect(await state(open.id)).toBe('open'); expect(await state(closed.id)).toBe('closed');
});
it('closes, reopens and locks via distinct approved operations with immutable versions', async () => {
  const row = await period();
  const closeId = await approval(ref(row.id));
  const first = await actor('u1', () => closePeriod(fixture.companyA, row.id, fixture.u1.id, { approvalId: closeId }));
  expect(first.status).toBe('closed');
  expect(await actor('u1', () => closePeriod(fixture.companyA, row.id, fixture.u1.id, { approvalId: closeId }))).toEqual(first);
  const reopenId = await approval(ref(row.id, 'fiscal_period.reopen'));
  expect((await actor('u1', () => reopenPeriod(fixture.companyA, row.id, { approvalId: reopenId }))).status).toBe('open');
  const closeAgain = await approval(ref(row.id));
  await actor('u1', () => closePeriod(fixture.companyA, row.id, fixture.u1.id, { approvalId: closeAgain }));
  const lockId = await approval(ref(row.id, 'fiscal_period.lock'));
  expect((await actor('u1', () => lockPeriod(fixture.companyA, row.id, { approvalId: lockId }))).status).toBe('locked');
  const events = await pool.query('SELECT action FROM control_change_events WHERE company_id=$1 AND entity_type=$2 AND entity_id=$3 ORDER BY new_version', [fixture.companyA, 'fiscal_period', row.id]);
  expect(events.rows.map(row => row.action)).toEqual(['baseline_observed', 'fiscal_period.close', 'fiscal_period.reopen', 'fiscal_period.close', 'fiscal_period.lock']);
});
it('binds year population and writes a versioned event for every changed child period', async () => {
  const a = await period(), b = await period('open', a.fiscalYear, 2);
  const operation: OperationRef = { entityType: 'fiscal_year', entityId: String(a.fiscalYear), operation: 'year.periods_close' };
  const id = await approval(operation);
  const result = await actor('u1', () => closeYear(fixture.companyA, a.fiscalYear, fixture.u1.id, { approvalId: id }));
  expect(result).toHaveLength(2); expect(await state(a.id)).toBe('closed'); expect(await state(b.id)).toBe('closed');
  const events = await pool.query("SELECT entity_id FROM control_change_events WHERE company_id=$1 AND action='year_closed_period'", [fixture.companyA]);
  expect(events.rows.map(row => row.entity_id).sort()).toEqual([a.id,b.id].sort());
});
it('refuses a stale period approval after real journal material changes', async () => {
  const row = await period(), id = await approval(ref(row.id));
  await actor('u1', () => createJournalEntry(fixture.companyA, { entryDate: row.start, description: 'Synthetic draft after approval', source: 'manual',
    lines: [{ glAccountId: accounts.bank, debit: 100, credit: 0 }, { glAccountId: accounts.payable, debit: 0, credit: 100 }] }, fixture.u1.id));
  await expect(actor('u1', () => closePeriod(fixture.companyA, row.id, fixture.u1.id, { approvalId: id }))).rejects.toThrow('material');
  expect(await state(row.id)).toBe('open');
});
it('requires a person-bound immutable lockdown intent while harmless settings retain their behavior', async () => {
  await actor('u1', () => updateCompany(fixture.companyA, { tradingName: 'Synthetic harmless name' }));
  await expect(actor('u1', () => updateCompany(fixture.companyA, { lockdownEnabled: true, lockdownDate: '2026-08-31' }))).rejects.toThrow('intent');
  const intent = await actor('u1', ctx => requestLockdownChange(ctx, { enabled: true, date: '2026-08-31' }));
  const id = await approval({ entityType: 'company_lockdown_intent', entityId: intent.intentId, operation: 'company_lockdown.change' });
  await expect(actor('u2', () => updateCompany(fixture.companyA, { lockdownEnabled: true, lockdownDate: '2026-08-31' }, { lockdownIntentId: intent.intentId, approvalId: id }))).rejects.toThrow('requester');
  const result = await actor('u1', () => updateCompany(fixture.companyA, { lockdownEnabled: true, lockdownDate: '2026-08-31' }, { lockdownIntentId: intent.intentId, approvalId: id }));
  expect(result.lockdownEnabled).toBe(true);
  const disabled = await actor('u1', ctx => requestLockdownChange(ctx, { enabled: false, date: null }));
  const disableApproval = await approval({ entityType: 'company_lockdown_intent', entityId: disabled.intentId, operation: 'company_lockdown.change' });
  const unlocked = await actor('u1', () => updateCompany(fixture.companyA, { lockdownEnabled: false, lockdownDate: null }, { lockdownIntentId: disabled.intentId, approvalId: disableApproval }));
  expect(unlocked.lockdownEnabled).toBe(false); expect(unlocked.lockdownDate).toBeNull();
});
it('stores server-derived VAT figures and requires approval instead of accepting caller figures or actor labels', async () => {
  const row = await period();
  const journal = await actor('u1', () => createJournalEntry(fixture.companyA, { entryDate: row.start, source: 'manual',
    lines: [{ glAccountId: accounts.default_expense, debit: 100, credit: 0, vatType: 'standard' },
      { glAccountId: accounts.vat_input, debit: 15, credit: 0 }, { glAccountId: accounts.payable, debit: 0, credit: 115 }] }, fixture.u1.id));
  await actor('u1', () => postJournalEntry(fixture.companyA, journal.id, fixture.u1.id));
  const forged = { outputTax: 987654, inputTax: 765432, netVat: 222222, postedThrough: '2099-01-01T00:00:00Z' };
  const invoke = (approvalId?: string) => lockVatPeriod(fixture.companyA, row.start, row.end, forged,
    { userId: fixture.u1.id, actorType: 'system', tokenJti: 'invented-actor' }, undefined, { approvalId });
  await expect(actor('u1', () => invoke())).rejects.toThrow('approval');
  const id = await approval({ entityType: 'vat_period', entityId: `${row.start}/${row.end}`, operation: 'vat_period.lock' });
  const result = await actor('u1', () => invoke(id));
  expect(result.created).toBe(true); expect(result.lock.outputTax).toBe(0); expect(result.lock.inputTax).toBe(15); expect(result.lock.netVat).toBe(-15);
  expect(result.lock.actorType).toBe('human'); expect(result.lock.actorTokenJti).toBeNull();
  const replay = await actor('u1', () => invoke()); expect(replay.created).toBe(false); expect(replay.lock).toEqual(result.lock);
});
it('serializes a period close against the actual journal posting service', async () => {
  const row = await period();
  const journal = await actor('u1', () => createJournalEntry(fixture.companyA, { entryDate: row.start, description: 'Synthetic racing post', source: 'manual',
    lines: [{ glAccountId: accounts.bank, debit: 100, credit: 0 }, { glAccountId: accounts.payable, debit: 0, credit: 100 }] }, fixture.u1.id));
  const id = await approval(ref(row.id));
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const closing = actor('u1', async () => { await closePeriod(fixture.companyA, row.id, fixture.u1.id, { approvalId: id }); entered(); await hold; });
  await ready;
  const label = `synthetic-period-post-${randomUUID()}`;
  const posting = actor('u1', () => postJournalEntry(fixture.companyA, journal.id, fixture.u1.id), label).then(() => null, error => error as Error);
  try {
    let waiting = false;
    for (let n=0;n<50;n++) {
      const rows = await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [label]);
      if (rows.rowCount) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve,20));
    }
    expect(waiting).toBe(true);
  } finally { release(); }
  await closing; expect(await posting).toBeInstanceOf(Error); expect(await state(row.id)).toBe('closed');
  expect((await pool.query('SELECT status FROM gl_journal_entries WHERE company_id=$1 AND id=$2', [fixture.companyA, journal.id])).rows[0].status).toBe('draft');
});
