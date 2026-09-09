import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { fixtureConfigFromEnv } from '../../scripts/forensic/fixture-bootstrap';
import { provisionForensicFixture, validateFixtureTarget, type ForensicFixture } from './forensic-fixture';
import { withControlRequest, requireControlTx } from '../../src/modules/accounting/services/controls/context';
import { recordCommittedChange } from '../../src/modules/accounting/services/controls/changeEventService';
import { openProtectedChange } from '../../src/modules/accounting/services/controls/changeProtection';
import { readControlEntityVersion } from '../../src/modules/accounting/services/controls/operationVersions';
import type { ControlTx, ChangeEventInput } from '../../src/modules/accounting/services/controls/contracts';

const config = fixtureConfigFromEnv(process.env), target = validateFixtureTarget(config);
process.env.DATABASE_URL = target.connectionString;
process.env.DATABASE_SSL = 'disable';
process.env.ENCRYPTION_KEY = 'synthetic-forensic-change-evidence-key-0123456789';
const pool = new Pool({ connectionString: target.connectionString, ssl: false, max: 3 });
let fixture: ForensicFixture;
beforeAll(async () => { fixture = await provisionForensicFixture(config); });
afterAll(async () => {
  await pool.end();
  const { getPoolForTests } = await import('../../src/lib/neon'); await getPoolForTests().end();
});

async function transact<T>(company: string, user: string, fn: (ctx: ControlTx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL ROLE app_user');
    const claims = { sub: user, company_id: company, role: 'authenticated' };
    await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)", [JSON.stringify(claims), company]);
    const result = await withControlRequest({ client, userId: user, companyId: company, claims },
      { personId: user, companyId: company, authMethod: 'cookie' }, () => fn(requireControlTx()));
    await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
function change(entityId: string): ChangeEventInput {
  return { entityType: 'supplier', entityId, previousVersion: null, newVersion: 1, action: 'created',
    accountingDate: '2026-09-09', before: null,
    after: { name: 'Synthetic supplier', bank_account_number: '000123456789' },
    bindingHash: null, protectedEvidenceRef: null };
}
it('commits exact restricted evidence and redacted event with authenticated actor and actual time', async () => {
  const id = randomUUID(), operationId = randomUUID();
  const event = await transact(fixture.companyA, fixture.u1.id, async ctx => {
    const [clock] = await ctx.sql`SELECT transaction_timestamp() AS started` as { started: Date }[];
    expect(await readControlEntityVersion(ctx, change(id))).toBeNull();
    await ctx.sql`SELECT pg_sleep(0.02)`;
    await ctx.sql`INSERT INTO suppliers(id,company_id,name) VALUES(${id}::uuid,${fixture.companyA}::uuid,'Synthetic supplier')`;
    const event = await recordCommittedChange(ctx, { ...change(id), operationId });
    expect(await readControlEntityVersion(ctx, change(id))).toMatchObject({ version: 1 });
    return { ...event, started: clock!.started };
  });
  const row = (await pool.query('SELECT * FROM control_change_events WHERE company_id=$1 AND id=$2', [fixture.companyA, event.eventId])).rows[0];
  expect(row.person_id).toBe(fixture.u1.id); expect(row.after_values).toEqual({ name: 'Synthetic supplier' });
  expect(row.operation_id).toBe(operationId);
  expect(row.outcome).toBe('committed'); expect(row.occurred_at).toBeInstanceOf(Date);
  expect(row.occurred_at.getTime()).toBeGreaterThan(event.started.getTime());
  const protectedRow = (await pool.query('SELECT * FROM control_protected_evidence WHERE company_id=$1 AND id=$2', [fixture.companyA, row.protected_evidence_id])).rows[0];
  expect(openProtectedChange({ version: protectedRow.envelope_version, keyId: protectedRow.key_id, ciphertext: protectedRow.ciphertext }).after)
    .toEqual(change(id).after);
});
it('outer rollback removes domain effect, version, event and restricted evidence together', async () => {
  const id = randomUUID();
  await expect(transact(fixture.companyA, fixture.u1.id, async ctx => {
    await ctx.sql`INSERT INTO suppliers(id,company_id,name) VALUES(${id}::uuid,${fixture.companyA}::uuid,'Rolled back supplier')`;
    await recordCommittedChange(ctx, change(id)); throw new Error('synthetic rollback');
  })).rejects.toThrow('synthetic rollback');
  expect((await pool.query('SELECT id FROM suppliers WHERE company_id=$1 AND id=$2', [fixture.companyA,id])).rows).toHaveLength(0);
  for (const table of ['control_entity_versions','control_change_events','control_protected_evidence']) {
    // Fixed test-only table whitelist, never caller-supplied identifiers.
    expect((await pool.query(`SELECT entity_id FROM ${table} WHERE company_id=$1 AND entity_id=$2`, [fixture.companyA,id])).rows).toHaveLength(0);
  }
});
it('concurrent first version creation succeeds once, and tenant B cannot read its event', async () => {
  const id = randomUUID();
  const outcomes = await Promise.allSettled([1,2].map(() => transact(fixture.companyA, fixture.u1.id, ctx => recordCommittedChange(ctx, change(id)))));
  expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
  expect((await pool.query('SELECT id FROM control_change_events WHERE company_id=$1 AND entity_id=$2', [fixture.companyA,id])).rows).toHaveLength(1);
  const rows = await transact(fixture.companyB, fixture.u3.id, ctx => ctx.sql`SELECT id FROM control_change_events WHERE company_id=${fixture.companyA}::uuid AND entity_id=${id}`);
  expect(rows).toHaveLength(0);
});
it('caught mandatory evidence failure still rolls back the earlier domain mutation', async () => {
  const id = randomUUID(), previousKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = '';
  try {
    await expect(transact(fixture.companyA, fixture.u1.id, async ctx => {
      await ctx.sql`INSERT INTO suppliers(id,company_id,name) VALUES(${id}::uuid,${fixture.companyA}::uuid,'Must rollback')`;
      await recordCommittedChange(ctx, change(id)).catch(() => 'handler catches refusal');
    })).rejects.toThrow('evidence');
  } finally { process.env.ENCRYPTION_KEY = previousKey; }
  expect((await pool.query('SELECT id FROM suppliers WHERE company_id=$1 AND id=$2', [fixture.companyA,id])).rows).toHaveLength(0);
});
