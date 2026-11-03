/**
 * Migration 950: MCP audit reads are pinned to app.current_company_id(), even when the same
 * user belongs to another company. The existing insert check remains unchanged.
 * Real PostgreSQL; synthetic rows only.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const migration = readFileSync('scripts/migrations/sql/950_mcp_tool_calls_pinned_company_rls.sql', 'utf8');

const COMPANY_A = '95000000-0000-4000-8000-00000000000a';
const COMPANY_B = '95000000-0000-4000-8000-00000000000b';
const USER = 'migration-950-two-company-user';
const ROW_A = '95000000-0000-4000-8000-00000000001a';
const ROW_B = '95000000-0000-4000-8000-00000000001b';

function rollbackSql(): string {
  const marked = /^-- ROLLBACK SQL BEGIN$([\s\S]*?)^-- ROLLBACK SQL END$/m.exec(migration)?.[1];
  if (!marked) throw new Error('migration 950 must carry executable rollback SQL markers');
  return marked
    .split('\n')
    .map((line) => line.replace(/^-- ?/, ''))
    .join('\n');
}

async function setAppContext(client: PoolClient, companyId: string): Promise<void> {
  await client.query('SET LOCAL ROLE app_user');
  await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: USER })]);
  await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [companyId]);
}

async function visibleCompanies(client: PoolClient): Promise<string[]> {
  return (await client.query<{ company_id: string }>(
    `SELECT company_id FROM mcp_tool_calls WHERE user_id = $1 ORDER BY company_id`, [USER],
  )).rows.map((row) => row.company_id);
}

beforeAll(async () => {
  await pool.query(
    `INSERT INTO companies (id, name, is_active)
     VALUES ($1, 'Migration 950 A', true), ($2, 'Migration 950 B', true)`,
    [COMPANY_A, COMPANY_B],
  );
  await pool.query(
    `INSERT INTO users (id, email, is_active)
     VALUES ($1, 'migration-950@example.test', true)`,
    [USER],
  );
  await pool.query(
    `INSERT INTO company_users (company_id, user_id, role)
     VALUES ($1, $3, 'admin'), ($2, $3, 'admin')`,
    [COMPANY_A, COMPANY_B, USER],
  );
  await pool.query(
    `INSERT INTO mcp_tool_calls (id, company_id, user_id, tool, args_hash, status)
     VALUES ($1, $2, $5, 'trial_balance', 'hash-a', 'ok'),
            ($3, $4, $5, 'trial_balance', 'hash-b', 'ok')`,
    [ROW_A, COMPANY_A, ROW_B, COMPANY_B, USER],
  );
});

afterAll(async () => {
  try {
    await pool.query(`DELETE FROM mcp_tool_calls WHERE user_id = $1`, [USER]);
    await pool.query(`DELETE FROM company_users WHERE user_id = $1`, [USER]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await pool.query(`DELETE FROM companies WHERE id = ANY($1::uuid[])`, [[COMPANY_A, COMPANY_B]]);
  } finally {
    await pool.end();
  }
});

describe('950: MCP tool-call audit RLS uses the pinned company', () => {
  it('shows only A while the same user belongs to A and B', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await setAppContext(client, COMPANY_A);
      expect(await visibleCompanies(client)).toEqual([COMPANY_A]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('keeps the existing write check: A inserts, B is refused', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await setAppContext(client, COMPANY_A);
      await client.query(
        `INSERT INTO mcp_tool_calls (company_id, user_id, tool, args_hash, status)
         VALUES ($1, $2, 'list_accounts', 'hash-valid', 'ok')`,
        [COMPANY_A, USER],
      );
      await client.query('SAVEPOINT foreign_company_insert');
      await expect(client.query(
        `INSERT INTO mcp_tool_calls (company_id, user_id, tool, args_hash, status)
         VALUES ($1, $2, 'list_accounts', 'hash-invalid', 'ok')`,
        [COMPANY_B, USER],
      )).rejects.toThrow(/row-level security/i);
      await client.query('ROLLBACK TO SAVEPOINT foreign_company_insert');
      expect((await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM mcp_tool_calls WHERE args_hash = 'hash-valid'`,
      )).rows[0]!.n).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rolls back to the prior policy and reapplies the migration cleanly', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(rollbackSql());
      await setAppContext(client, COMPANY_A);
      expect(await visibleCompanies(client)).toEqual([COMPANY_A, COMPANY_B]);

      await client.query('RESET ROLE');
      await client.query(migration);
      await setAppContext(client, COMPANY_A);
      expect(await visibleCompanies(client)).toEqual([COMPANY_A]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
