import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PAT_SCOPES } from '../../src/lib/auth/patScopes';

export interface FixtureConfig {
  optIn?: string;
  databaseUrl?: string;
  generatedPort?: string;
  fixtureLabel?: string;
}

/** No DATABASE_URL fallback: a caller must explicitly select the disposable DB. */
export function validateFixtureTarget(config: FixtureConfig) {
  if (config.optIn !== '1' || !config.databaseUrl) throw new Error('Explicit forensic fixture opt-in and URL required');
  let url: URL;
  try { url = new URL(config.databaseUrl); } catch { throw new Error('Invalid forensic fixture URL'); }
  const port = Number(url.port);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.pathname !== '/isaflow_schema_fixture'
    || url.search || url.hash || !url.username) {
    throw new Error('Only an explicit local forensic fixture database is allowed');
  }
  const generated = config.generatedPort;
  if (port !== 33149 && !(generated && /^\d{5}$/.test(generated)
    && Number(generated) >= 1024 && Number(generated) <= 65535
    && port === Number(generated) && config.fixtureLabel === `isaflow-forensic-${generated}`)) {
    throw new Error('Unapproved forensic fixture port or label');
  }
  return { connectionString: url.toString(), port };
}

export interface FixtureToken { id: string; raw: string; hash: string; prefix: string }
export interface FixtureUser {
  id: string; companyId: string; email: string; tokens: FixtureToken[];
}
export interface ForensicFixture {
  runId: string; companyA: string; companyB: string;
  u1: FixtureUser; u2: FixtureUser; u3: FixtureUser;
}

function token(): FixtureToken {
  let body = '';
  while (body.length < 32) body += randomBytes(48).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  const raw = `pat_${body.slice(0, 32)}`;
  return { id: randomUUID(), raw, hash: createHash('sha256').update(raw).digest('hex'), prefix: raw.slice(0, 12) };
}

/** Values are synthetic and tokens live only in the returned in-memory fixture. */
export function createFixtureIdentity(): ForensicFixture {
  const companyA = randomUUID(), companyB = randomUUID();
  function user(companyId: string, count: number): FixtureUser {
    const id = randomUUID();
    return { id, companyId, email: `${id}@forensic.invalid`, tokens: Array.from({ length: count }, token) };
  }
  return { runId: randomUUID(), companyA, companyB, u1: user(companyA, 2), u2: user(companyA, 1), u3: user(companyB, 1) };
}

/** Creates only synthetic users, memberships and PAT hashes in one transaction. */
export async function provisionForensicFixture(config: FixtureConfig): Promise<ForensicFixture> {
  const target = validateFixtureTarget(config); // BEFORE pool construction/connect/mutations.
  const pool = new Pool({ connectionString: target.connectionString, ssl: false, max: 1,
    connectionTimeoutMillis: 3000, statement_timeout: 5000, application_name: 'isaflow-forensic-fixture' });
  const fixture = createFixtureIdentity();
  try {
    const client = await pool.connect();
    try {
      const probe = await client.query<{ database: string }>('SELECT current_database() AS database');
      if (probe.rows[0]?.database !== 'isaflow_schema_fixture') throw new Error('Unexpected fixture database');
      await client.query('BEGIN');
      try {
        await client.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
          [fixture.companyA, `Forensic A ${fixture.runId}`, fixture.companyB, `Forensic B ${fixture.runId}`]);
        for (const user of [fixture.u1, fixture.u2, fixture.u3]) {
          await client.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'viewer',true)", [user.id, user.email]);
          await client.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [user.companyId, user.id]);
          for (const pat of user.tokens) {
            await client.query(`INSERT INTO personal_access_tokens
              (id,user_id,company_id,token_hash,token_prefix,name,scopes,expires_at)
              VALUES($1,$2,$3,$4,$5,$6,$7,NOW()+INTERVAL '1 day')`,
            [pat.id, user.id, user.companyId, pat.hash, pat.prefix, `Forensic ${fixture.runId}`, [...PAT_SCOPES]]);
          }
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } finally { client.release(); }
    return fixture;
  } finally { await pool.end(); }
}

/** Ensures an open fiscal period covers `dateStr` for `companyId`, and returns its id. Reuses
 * whatever period already covers the date (a fixed-date fixture period, most of the time); only
 * inserts a single-day period when nothing does. Never an unconditional insert: a fixed-date
 * fixture period (e.g. "September 2026") stops covering the date the moment the calendar moves
 * past it, and calling this twice for two dates in the same month must not collide on
 * uq_fiscal_periods_company_year_period — period_number is picked as the next unused value for
 * (company, fiscal_year), never derived from the calendar month, so two single-day periods in the
 * same month never fight over one period_number. Retries past a lost race on that pick (23505). If
 * a period already covers the date but isn't open, there is no way to add an open one without
 * violating the no-overlap exclusion (migration 502), so this throws rather than silently using a
 * closed/locked period. */
export async function ensureOpenPeriod(pool: Pool, companyId: string, dateStr: string, label: string): Promise<string> {
  const { rows: [covering] } = await pool.query<{ id: string; status: string }>(
    "SELECT id,status FROM fiscal_periods WHERE company_id=$1 AND start_date<=$2::date AND end_date>=$2::date",
    [companyId, dateStr]);
  if (covering) {
    if (covering.status !== 'open') throw new Error(`Fiscal period covering ${dateStr} is ${covering.status}, not open`);
    return covering.id;
  }
  const fiscalYear = Number(dateStr.slice(0, 4));
  for (let attempt = 0; attempt < 50; attempt++) {
    const { rows: [next] } = await pool.query<{ n: number }>(
      'SELECT COALESCE(MAX(period_number),0)+1 AS n FROM fiscal_periods WHERE company_id=$1 AND fiscal_year=$2',
      [companyId, fiscalYear]);
    const id = randomUUID();
    try {
      await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
        VALUES($1,$2,$3,$4,$5,$6::date,$6::date,'open')`,
        [id, companyId, label, next!.n, fiscalYear, dateStr]);
      return id;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') continue; // period_number race — recompute and retry
      throw error;
    }
  }
  throw new Error(`Could not allocate a unique fiscal period number for ${companyId}/${fiscalYear}`);
}
/** The open period for "today" must be derived from the DB clock, never a literal. */
export async function ensureOpenPeriodForToday(pool: Pool, companyId: string, label: string): Promise<string> {
  const { rows: [clock] } = await pool.query<{ day: string }>(
    "SELECT (clock_timestamp() AT TIME ZONE 'Africa/Johannesburg')::date::text AS day");
  return ensureOpenPeriod(pool, companyId, clock!.day, label);
}
