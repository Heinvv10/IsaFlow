import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { fixtureConfigFromEnv } from '../../../scripts/forensic/fixture-bootstrap';
import { provisionForensicFixture, validateFixtureTarget, type ForensicFixture } from '../forensic-fixture';
import { withControlRequest, requireControlTx } from '@/modules/accounting/services/controls/context';
import { materializeGlOperation } from '@/modules/accounting/services/controls/glOperationMaterializer';
import { operationBindingHash } from '@/modules/accounting/services/controls/canonical';
import { postJournalEntry, reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import type { ControlTx } from '@/modules/accounting/services/controls/contracts';
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.CONTROL_FINGERPRINT_KEY = randomBytes(32).toString('hex');
const config = fixtureConfigFromEnv(process.env), target = validateFixtureTarget(config);
const pool = new Pool({ connectionString: target.connectionString, ssl: false, max: 2 });
let fixture: ForensicFixture;
const tax = randomUUID(), expense = randomUUID(), bank = randomUUID(), august = randomUUID(), september = randomUUID();
async function actor<T>(fn: (ctx: ControlTx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",
      [JSON.stringify({ sub: fixture.u1.id, company_id: fixture.companyA, role: 'authenticated' }), fixture.companyA]);
    const result = await withControlRequest({ client, userId: fixture.u1.id, companyId: fixture.companyA, claims: {} },
      { personId: fixture.u1.id, companyId: fixture.companyA, authMethod: 'cookie' }, () => fn(requireControlTx()));
    await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function draft(vat = true) {
  const id = randomUUID();
  await pool.query(`INSERT INTO gl_journal_entries(id,company_id,entry_date,fiscal_period_id,source,status,created_by)
    VALUES($1,$2,'2026-08-31',$3,'manual','draft',$4)`, [id, fixture.companyA, august, fixture.u1.id]);
  await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit)
    VALUES($1,$2,$3,15,0),($1,$2,$4,0,15)`, [id, fixture.companyA, vat ? tax : expense, bank]);
  return id;
}
async function lock(companyId = fixture.companyA) {
  await pool.query(`INSERT INTO vat_period_locks(company_id,period_start,period_end,output_tax,input_tax,net_vat,posted_through,locked_by)
    VALUES($1,'2026-07-01','2026-08-31',0,15,-15,clock_timestamp(),$2) ON CONFLICT DO NOTHING`, [companyId, fixture.u1.id]);
}
beforeAll(async () => {
  fixture = await provisionForensicFixture(config);
  for (const [id, subtype, type] of [[tax, 'vat_input', 'asset'], [expense, 'operating_expense', 'expense'], [bank, 'bank', 'asset']]) {
    await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active)
      VALUES($1,$2,$3,'Synthetic VAT guard',$4,$5,'debit',true)`, [id, fixture.companyA, id!.slice(0, 12), type, subtype]);
  }
  await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
    VALUES($1,$3,'August',8,2026,'2026-08-01','2026-08-31','open'),($2,$3,'September',9,2026,'2026-09-01','2026-09-30','open')`,
  [august, september, fixture.companyA]);
});
afterAll(async () => { await pool.end(); });
it('binds newly filed VAT locks and refuses backdated shared posting without effects', async () => {
  const id = await draft();
  const inspect = () => actor(async ctx => operationBindingHash({ ...(await materializeGlOperation(ctx,
    { entityType: 'journal_entry', entityId: id, operation: 'journal.post' })).binding, policies: [] }));
  const before = await inspect(); await lock();
  expect(await inspect()).not.toBe(before);
  await expect(actor(() => postJournalEntry(fixture.companyA, id, fixture.u1.id))).rejects.toThrow('filed VAT');
  expect((await pool.query('SELECT status FROM gl_journal_entries WHERE company_id=$1 AND id=$2', [fixture.companyA, id])).rows[0].status).toBe('draft');
  expect((await pool.query('SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2', [fixture.companyA, id])).rows).toHaveLength(0);
});
it('allows genuine non-VAT journals in a filed VAT period', async () => {
  const id = await draft(false);
  expect((await actor(() => postJournalEntry(fixture.companyA, id, fixture.u1.id))).status).toBe('posted');
});
it('allows a correction in the next open VAT period but refuses a backdated contra', async () => {
  const id = await draft();
  await pool.query("UPDATE gl_journal_entries SET status='posted',posted_at=clock_timestamp() WHERE company_id=$1 AND id=$2", [fixture.companyA, id]);
  await expect(actor(() => reverseJournalEntry(fixture.companyA, id, fixture.u1.id, { reversalDate: '2026-08-31' }))).rejects.toThrow('filed VAT');
  const result = await actor(() => reverseJournalEntry(fixture.companyA, id, fixture.u1.id, { reversalDate: '2026-09-09' }));
  expect(result.status).toBe('posted'); expect(result.entryDate).toBe('2026-09-09');
});
