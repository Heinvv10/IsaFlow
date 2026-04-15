/**
 * Integration test: BL-43 — startRun must persist company_id
 *
 * Root cause: startRun INSERTs into gl_migration_runs without company_id.
 * getMigrationStatus filters runs by company_id → every run invisible.
 *
 * Properties under test:
 *   A: startRun persists company_id (row has correct company_id)
 *   B: getMigrationStatus for company A sees company A's run
 *   C: getMigrationStatus for company B does NOT see company A's run
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { sql } from '@/lib/neon';
import { startRun, completeRun, getMigrationStatus } from '@/modules/accounting/services/core/sageMigrationService';

const COMPANY_A = '00000000-0000-0000-b143-000000000aa1';
const COMPANY_B = '00000000-0000-0000-b143-000000000bb2';
const USER_ID   = '00000000-0000-0000-b143-000000000001';

const createdRunIds: string[] = [];

async function ensureTestCompany(id: string, name: string): Promise<void> {
  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${id}::UUID, ${name}, 'BL43-TEST', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

beforeAll(async () => {
  await Promise.all([
    ensureTestCompany(COMPANY_A, 'BL43 Test Company A'),
    ensureTestCompany(COMPANY_B, 'BL43 Test Company B'),
  ]);
});

afterAll(async () => {
  if (createdRunIds.length > 0) {
    await sql`DELETE FROM gl_migration_runs WHERE id = ANY(${createdRunIds}::UUID[])`;
  }
});

describe('BL-43: startRun persists company_id', () => {
  it('A: startRun persists company_id on the row', async () => {
    const runId = await startRun('ledger_import', USER_ID, COMPANY_A);
    createdRunIds.push(runId);

    const rows = await sql`
      SELECT company_id FROM gl_migration_runs WHERE id = ${runId}::UUID
    ` as Array<{ company_id: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].company_id).toBe(COMPANY_A);
  });

  it('B: getMigrationStatus for company A sees company A run', async () => {
    const runId = await startRun('invoice_import', USER_ID, COMPANY_A);
    createdRunIds.push(runId);
    await completeRun(runId, 0, 0, 0, 0);

    const status = await getMigrationStatus(COMPANY_A);
    const found = status.lastRuns.some((r) => r.id === runId);
    expect(found).toBe(true);
  });

  it('C: getMigrationStatus for company B does NOT see company A run', async () => {
    const runId = await startRun('customer_invoice_import', USER_ID, COMPANY_A);
    createdRunIds.push(runId);
    await completeRun(runId, 0, 0, 0, 0);

    const status = await getMigrationStatus(COMPANY_B);
    const found = status.lastRuns.some((r) => r.id === runId);
    expect(found).toBe(false);
  });
});
