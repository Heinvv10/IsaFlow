/**
 * The Demo company reseed and the intercompany tables (migration 1002). Connections, messages and links have no company_id (a pair
 * of companies), so the census cannot see them: a guard refuses while one names the Demo company. The lock rows and the document
 * slots have a company_id but no app role can read them: the census lists tables through information_schema.columns, which shows a
 * role only the columns it may access, so a reseed role that does NOT inherit migration_admin (production's non-superuser) never
 * reads them and cannot fail with permission denied.
 *
 * Runs in the schema fixture inside ONE outer transaction rolled back in afterAll (as demo-reseed.int.test.ts).
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { DEMO, OTHER, companies } from './helpers/demoReseedFixture';
import { runReseed } from '../../scripts/lib/demoReseed/run';
import { txOver } from '../../scripts/lib/demoReseed/db';
import { censusUnclassified, keptReport } from '../../scripts/lib/demoReseed/wipe';
import { refuseUnsafe } from '../../scripts/lib/demoReseed/guards';

const CLOSED = ['intercompany_company_locks', 'intercompany_document_slots'];
const ZERO = '00000000-0000-0000-0000-000000000000';   // sorts below Demo: Demo is the HIGH company of a pair with it
const THIRD = '7e5d0000-0000-4000-8000-0000000000bb';
let c: pg.Client;

async function inSavepoint<T>(fn: () => Promise<T>): Promise<T> {
  await c.query('SAVEPOINT probe');
  try { return await fn(); } finally { await c.query('ROLLBACK TO SAVEPOINT probe'); }
}
async function dryRun() {
  const lines: string[] = [];
  const r = await runReseed({ companyId: DEMO, mode: 'dry-run', seed: 7, today: '2026-11-16', client: c, out: (l) => lines.push(l) });
  return { exitCode: r.exitCode, text: lines.join('\n') };
}
const pair = (x: string, y: string) => (x < y ? [x, y] : [y, x]);
/** A connection between OTHER and THIRD (neither is Demo), the guards off: a fixture, not a flow. */
async function connectionAway(): Promise<string> {
  await c.query('ALTER TABLE intercompany_connections DISABLE TRIGGER trg_intercompany_connections_guard');
  const [low, high] = pair(OTHER, THIRD);
  return (await c.query(
    `INSERT INTO intercompany_connections(company_low_id, company_high_id, kind, status, invited_by_company_id, invited_by, accepted_by, accepted_at) VALUES ($1, $2, 'group', 'active', $1, 'reseed-test', 'reseed-test', now()) RETURNING id`, [low, high])).rows[0].id as string;
}

beforeAll(async () => {
  assertDisposable();
  c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('BEGIN');
  await companies(c);
  await c.query(`INSERT INTO companies (id, name) VALUES ($1, 'Third Tenant (Pty) Ltd'), ($2, 'Zero Tenant (Pty) Ltd')`, [THIRD, ZERO]);
}, 120_000);

afterAll(async () => {
  if (!c) return;
  await c.query('ROLLBACK');
  await c.end();
});

describe('a connection, message or link that names the Demo company refuses the run, cleanly, before any write', () => {
  it('a connection naming Demo', async () => {
    await inSavepoint(async () => {
      await c.query('ALTER TABLE intercompany_connections DISABLE TRIGGER trg_intercompany_connections_guard');
      const [low, high] = pair(DEMO, OTHER);
      await c.query(`INSERT INTO intercompany_connections(company_low_id, company_high_id, kind, status, invited_by_company_id, invited_by, accepted_by, accepted_at) VALUES ($1, $2, 'group', 'active', $1, 'reseed-test', 'reseed-test', now())`, [low, high]);
      const r = await dryRun();
      expect(r.exitCode).toBe(2);
      expect(r.text).toMatch(/intercompany rows name the Demo company: intercompany_connections \(1\): not handled, resolve them first/);
    });
  });

  it('a connection naming Demo as the HIGH company', async () => {
    await inSavepoint(async () => {
      await c.query('ALTER TABLE intercompany_connections DISABLE TRIGGER trg_intercompany_connections_guard');
      await c.query(`INSERT INTO intercompany_connections(company_low_id, company_high_id, kind, status, invited_by_company_id, invited_by, accepted_by, accepted_at) VALUES ($1, $2, 'group', 'active', $1, 'reseed-test', 'reseed-test', now())`, [ZERO, DEMO]);
      const r = await dryRun();
      expect(r.exitCode).toBe(2);
      expect(r.text).toMatch(/intercompany_connections \(1\)/);
    });
  });

  it('a message naming Demo (a connection between two other companies)', async () => {
    await inSavepoint(async () => {
      const id = await connectionAway();
      await c.query('ALTER TABLE intercompany_messages DISABLE TRIGGER trg_intercompany_messages_guard');
      await c.query(`INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
                     VALUES ($1, $2, $3, 'payment', 'payment', gen_random_uuid(), '{}')`, [id, OTHER, DEMO]);
      const r = await dryRun();
      expect(r.exitCode).toBe(2);
      expect(r.text).toMatch(/intercompany rows name the Demo company: intercompany_messages \(1\): not handled/);
    });
  });

  it('a message sent BY Demo (OTHER receives it)', async () => {
    await inSavepoint(async () => {
      const id = await connectionAway();
      await c.query('ALTER TABLE intercompany_messages DISABLE TRIGGER trg_intercompany_messages_guard');
      await c.query(`INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
                     VALUES ($1, $2, $3, 'payment', 'payment', gen_random_uuid(), '{}')`, [id, DEMO, OTHER]);
      const r = await dryRun();
      expect(r.exitCode).toBe(2);
      expect(r.text).toMatch(/intercompany_messages \(1\)/);
    });
  });

  it('a link naming Demo as company B (the high side of the link)', async () => {
    await inSavepoint(async () => {
      const id = await connectionAway();
      await c.query('ALTER TABLE intercompany_document_links DISABLE TRIGGER trg_intercompany_links_guard');
      await c.query(`INSERT INTO intercompany_document_links(connection_id, company_a_id, doc_a_type, doc_a_id, company_b_id, doc_b_type, doc_b_id, origin, status, created_by)
                     VALUES ($1, $2, 'customer_invoice', gen_random_uuid(), $3, 'supplier_invoice', gen_random_uuid(), 'manual_pairing', 'pending_confirmation', 'reseed-test')`, [id, THIRD, DEMO]);
      const r = await dryRun();
      expect(r.exitCode).toBe(2);
      expect(r.text).toMatch(/intercompany_document_links \(1\)/);
    });
  });

  it('a link naming Demo (a connection between two other companies)', async () => {
    await inSavepoint(async () => {
      const id = await connectionAway();
      await c.query('ALTER TABLE intercompany_document_links DISABLE TRIGGER trg_intercompany_links_guard');
      await c.query(`INSERT INTO intercompany_document_links(connection_id, company_a_id, doc_a_type, doc_a_id, company_b_id, doc_b_type, doc_b_id, origin, status, created_by)
                     VALUES ($1, $2, 'customer_invoice', gen_random_uuid(), $3, 'supplier_invoice', gen_random_uuid(), 'manual_pairing', 'pending_confirmation', 'reseed-test')`, [id, DEMO, THIRD]);
      const r = await dryRun();
      expect(r.exitCode).toBe(2);
      expect(r.text).toMatch(/intercompany rows name the Demo company: intercompany_document_links \(1\): not handled/);
    });
  });

  it('none of them: the guard is silent (connections between other companies do not matter)', async () => {
    await inSavepoint(async () => {
      await connectionAway();
      const r = await dryRun();
      expect(r.text).not.toMatch(/intercompany rows name the Demo company/);
      expect(r.exitCode).toBe(0);                                                // the run proceeds: the guard did not refuse
      await expect(refuseUnsafe(txOver(c), DEMO, () => undefined)).resolves.toBeUndefined();
    });
  });
});

describe('a reseed role that cannot read the closed intercompany tables (it never sees them: information_schema shows only what it may access)', () => {
  it('the census, the kept report and the refusals run as a BYPASSRLS role that is NOT a member of migration_admin and holds no grant on the lock or slot tables', async () => {
    await inSavepoint(async () => {
      await c.query('CREATE ROLE ic_reseed_probe NOLOGIN NOSUPERUSER BYPASSRLS');
      await c.query('GRANT USAGE ON SCHEMA public TO ic_reseed_probe');
      const tables = (await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> ALL($1)`, [CLOSED])).rows.map((r) => r.tablename as string);
      for (const t of tables) await c.query(`GRANT SELECT ON public.${t} TO ic_reseed_probe`);
      expect((await c.query(`SELECT pg_has_role('ic_reseed_probe', 'migration_admin', 'USAGE') AS m`)).rows[0].m).toBe(false);
      await c.query('GRANT ic_reseed_probe TO CURRENT_USER');                       // so SET ROLE works for a non-superuser runner too
      await c.query('SET LOCAL ROLE ic_reseed_probe');
      try {
        for (const t of CLOSED) {
          expect((await c.query(`SELECT has_table_privilege(current_user, $1, 'SELECT') AS ok`, [`public.${t}`])).rows[0].ok, t).toBe(false);
          await c.query('SAVEPOINT direct');
          await expect(c.query(`SELECT count(*) FROM ${t} WHERE company_id = $1`, [DEMO])).rejects.toMatchObject({ code: '42501' });   // what the census used to do
          await c.query('ROLLBACK TO SAVEPOINT direct');
        }
        const tx = txOver(c);
        expect(await censusUnclassified(tx, DEMO)).toEqual([]);
        expect(Array.isArray(await keptReport(tx, DEMO))).toBe(true);
        await expect(refuseUnsafe(tx, DEMO, () => undefined)).resolves.toBeUndefined();
      } finally {
        await c.query('RESET ROLE');
      }
    });
  });

  it('a role that CAN read them (a superuser, or an inheriting runner) still counts them: the kept lock rows are reported', async () => {
    const kept = await keptReport(txOver(c), DEMO);
    expect(kept.map((k) => k.table)).toContain('intercompany_company_locks');
  });
});

describe('a clean refusal when the guard cannot read the intercompany tables', () => {
  it.each(['intercompany_connections', 'intercompany_messages', 'intercompany_document_links'])('a role with no SELECT on %s: Refusal naming it (exit 2), not a raw 42501', async (table) => {
    await inSavepoint(async () => {
      await c.query('CREATE ROLE ic_reseed_nogrant NOLOGIN NOSUPERUSER BYPASSRLS');
      await c.query('GRANT USAGE ON SCHEMA public TO ic_reseed_nogrant');
      const tables = (await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> $1`, [table])).rows.map((r) => r.tablename as string);
      for (const t of tables) await c.query(`GRANT SELECT ON public.${t} TO ic_reseed_nogrant`);
      await c.query('GRANT ic_reseed_nogrant TO CURRENT_USER');
      await c.query('SET LOCAL ROLE ic_reseed_nogrant');
      try {
        await expect(refuseUnsafe(txOver(c), DEMO, () => undefined)).rejects.toMatchObject({
          name: 'Refusal', message: expect.stringContaining(`cannot check ${table} for the Demo company (this role cannot read it)`),
        });
      } finally {
        await c.query('ROLLBACK TO SAVEPOINT probe');      // the refused read aborted the transaction (as a real run's rollback does)
        await c.query('SAVEPOINT probe');
        await c.query('RESET ROLE');
      }
    });
  });

  it('a database from before migration 1000 (the table is missing): Refusal naming it', async () => {
    await inSavepoint(async () => {
      await c.query('ALTER TABLE intercompany_messages RENAME TO intercompany_messages_gone');
      await expect(refuseUnsafe(txOver(c), DEMO, () => undefined)).rejects.toMatchObject({
        name: 'Refusal', message: expect.stringMatching(/cannot check intercompany_messages for the Demo company \(the table does not exist: migration 1000 is not applied\)/),
      });
    });
  });

  it('through the whole run: exit code 2, the message on the output, nothing written', async () => {
    await inSavepoint(async () => {
      await c.query('ALTER TABLE intercompany_messages RENAME TO intercompany_messages_gone');
      const r = await dryRun();
      expect(r.exitCode).toBe(2);
      expect(r.text).toMatch(/cannot check intercompany_messages for the Demo company/);
    });
  });
});
