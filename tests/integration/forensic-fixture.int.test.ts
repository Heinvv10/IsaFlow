import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { fixtureConfigFromEnv } from '../../scripts/forensic/fixture-bootstrap';
import { provisionForensicFixture, validateFixtureTarget, type ForensicFixture } from './forensic-fixture';

const config = fixtureConfigFromEnv(process.env);
const target = validateFixtureTarget(config);
// The application PAT reader must use exactly the independently validated fixture.
process.env.DATABASE_URL = target.connectionString;
process.env.DATABASE_SSL = 'disable';
const pool = new Pool({ connectionString: target.connectionString, ssl: false, max: 2 });
let fixture: ForensicFixture;
beforeAll(async () => { fixture = await provisionForensicFixture(config); });
afterAll(async () => {
  await pool.end();
  const { getPoolForTests } = await import('../../src/lib/neon');
  await getPoolForTests().end();
});

it('provisions two tenants, three people, four hashed PATs and validates both U1 tokens', async () => {
  const companies = [fixture.companyA, fixture.companyB];
  expect((await pool.query('SELECT id FROM companies WHERE id=ANY($1::uuid[])', [companies])).rows).toHaveLength(2);
  expect((await pool.query('SELECT user_id FROM company_users WHERE company_id=ANY($1::uuid[])', [companies])).rows).toHaveLength(3);
  expect((await pool.query('SELECT id FROM users WHERE id=ANY($1::text[])', [[fixture.u1.id, fixture.u2.id, fixture.u3.id]])).rows).toHaveLength(3);
  const stored = (await pool.query('SELECT token_hash FROM personal_access_tokens WHERE company_id=ANY($1::uuid[])', [companies])).rows;
  expect(stored).toHaveLength(4);
  const { validatePat } = await import('../../src/lib/auth/personalAccessTokens');
  for (const user of [fixture.u1, fixture.u2, fixture.u3]) {
    for (const token of user.tokens) {
      expect(stored.some(row => row.token_hash === token.hash)).toBe(true);
      const result = await validatePat(token.raw, null);
      expect(result).toMatchObject({ patId: token.id, userId: user.id, companyId: user.companyId });
      expect(JSON.stringify(stored)).not.toContain(token.raw);
    }
  }
  expect(fixture.u1.tokens[0].id).not.toBe(fixture.u1.tokens[1].id);
});

it('enforces app_user RLS in both directions for synthetic tenant rows', async () => {
  const client = await pool.connect();
  try {
    for (const user of [fixture.u1, fixture.u3]) {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE app_user');
        await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",
          [JSON.stringify({ sub: user.id, role: 'authenticated', company_id: user.companyId }), user.companyId]);
        const result = await client.query('SELECT id FROM companies WHERE id=ANY($1::uuid[])', [[fixture.companyA, fixture.companyB]]);
        expect(result.rows).toEqual([{ id: user.companyId }]);
        const memberships = await client.query('SELECT company_id FROM company_users WHERE company_id=ANY($1::uuid[])', [[fixture.companyA, fixture.companyB]]);
        expect(memberships.rows.length).toBeGreaterThan(0);
        expect(memberships.rows.every(row => row.company_id === user.companyId)).toBe(true);
      } finally { await client.query('ROLLBACK'); }
    }
  } finally { client.release(); }
});

it('rolls back all new identities on a forced PAT insertion failure and closes fixture pools', async () => {
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM companies) companies,
    (SELECT count(*)::int FROM users) users,
    (SELECT count(*)::int FROM company_users) memberships,
    (SELECT count(*)::int FROM personal_access_tokens) tokens`)).rows[0];
  const before = await counts();
  async function withPatFault(run: () => Promise<void>, failSetup = false) {
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const name = 'forensic_fault_' + suffix;
    try {
      // Disposable DB only; identifiers and marker consist of generated UUID hex.
      await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF current_setting('isaflow.fixture_fault',true)=TG_ARGV[0]
          THEN RAISE EXCEPTION 'Synthetic PAT insert failure'; END IF; RETURN NEW; END $$`);
      const table = failSetup ? 'missing_forensic_' + suffix : 'personal_access_tokens';
      await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table}
        FOR EACH ROW EXECUTE FUNCTION ${name}('${suffix}')`);
      const previousOptions = process.env.PGOPTIONS;
      process.env.PGOPTIONS = `-c isaflow.fixture_fault=${suffix}`;
      try { await run(); } finally {
        if (previousOptions === undefined) delete process.env.PGOPTIONS;
        else process.env.PGOPTIONS = previousOptions;
      }
    } finally {
      const failures: unknown[] = [];
      // Attempt both cleanup statements even when the first fails. CASCADE is
      // bounded to our uniquely named function and its disposable trigger.
      for (const command of [`DROP TRIGGER IF EXISTS ${name} ON personal_access_tokens`,
        `DROP FUNCTION IF EXISTS ${name}() CASCADE`]) {
        try { await pool.query(command); } catch (error) { failures.push(error); }
      }
      expect((await pool.query('SELECT to_regproc($1) AS function', [name])).rows[0].function).toBeNull();
      if (failures.length) throw new AggregateError(failures, 'Disposable fault cleanup failed');
    }
  }
  // Prove cleanup when CREATE FUNCTION succeeded but CREATE TRIGGER fails.
  await expect(withPatFault(async () => { throw new Error('Must not execute'); }, true)).rejects.toThrow('does not exist');
  await withPatFault(async () => {
    await expect(provisionForensicFixture(config)).rejects.toThrow('Synthetic PAT insert failure');
    expect(await counts()).toEqual(before);
  });
  const clients = (await pool.query("SELECT pid FROM pg_stat_activity WHERE application_name='isaflow-forensic-fixture' AND datname=current_database()" )).rows;
  expect(clients).toHaveLength(0);
});
