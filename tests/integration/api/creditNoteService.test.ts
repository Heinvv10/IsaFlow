/**
 * Integration test: BL-42 — createCreditNote INSERT requires company_id
 *
 * Root cause: `createCreditNote` INSERT into credit_notes omitted company_id.
 * credit_notes.company_id is NOT NULL in DB → every call threw NotNullViolation.
 * Error bubbled up (not swallowed) so the feature is visibly broken rather than
 * silent, but no integration test existed to catch it.
 *
 * Properties under test:
 *   A: INSERT into credit_notes with company_id succeeds (was throwing pre-BL-42)
 *   B: INSERT into credit_notes WITHOUT company_id fails with NOT NULL violation
 *      (schema invariant guard — if this ever stops failing, company_id has
 *       been made nullable and this test should be revisited)
 *   C: Row created via createCreditNote is scoped to the expected company_id
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { sql } from '@/lib/neon';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_A = '00000000-0000-0000-b142-000000000aa1';
const USER_ID   = '00000000-0000-0000-b142-000000000001';

// ── State ─────────────────────────────────────────────────────────────────────

let customerA: string;
let createdIds: string[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function ensureTestCompany(id: string, name: string): Promise<void> {
  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${id}::UUID, ${name}, 'BL42-TEST', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

async function createCustomer(companyId: string): Promise<string> {
  const rows = await sql`
    INSERT INTO customers (name, company_id)
    VALUES ('BL42 Test Customer', ${companyId}::UUID)
    RETURNING id
  ` as Array<{ id: string }>;
  return rows[0].id;
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensureTestCompany(COMPANY_A, 'BL42 Test Company A');
  customerA = await createCustomer(COMPANY_A);
});

afterAll(async () => {
  if (createdIds.length > 0) {
    await sql`
      DELETE FROM credit_notes WHERE id = ANY(${createdIds}::UUID[])
    `;
  }
  await sql`DELETE FROM credit_notes WHERE company_id = ${COMPANY_A}::UUID`;
  await sql`DELETE FROM customers WHERE company_id = ${COMPANY_A}::UUID`;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BL-42: createCreditNote supplies company_id', () => {
  /**
   * A: The FIXED createCreditNote now includes company_id in INSERT.
   * Must succeed (previously threw NOT NULL violation on every call).
   */
  it('A: createCreditNote succeeds (was throwing pre-BL-42)', async () => {
    const cn = await createCreditNote(
      COMPANY_A,
      {
        type: 'customer',
        clientId: customerA,
        creditDate: '2026-04-15',
        reason: 'BL-42 integration test',
        subtotal: 100,
        taxRate: 15,
      },
      USER_ID,
    );

    expect(cn).toBeDefined();
    expect(cn.id).toBeDefined();
    createdIds.push(cn.id);
  });

  /**
   * B: Schema invariant guard. INSERT without company_id must throw.
   * If this ever passes, credit_notes.company_id has been made nullable
   * and we need to reassess the tenant isolation model.
   */
  it('B: raw INSERT into credit_notes WITHOUT company_id throws NOT NULL violation', async () => {
    await expect(sql`
      INSERT INTO credit_notes (
        type, client_id, credit_date, reason, subtotal, tax_rate, tax_amount, total_amount, created_by
      ) VALUES (
        'customer', ${customerA}::UUID, '2026-04-15', 'BL-42 schema guard',
        100, 15, 15, 115, ${USER_ID}::UUID
      )
    `).rejects.toThrow(/null value in column "company_id"|violates not-null/i);
  });

  /**
   * C: The row created via createCreditNote is scoped to the expected tenant.
   */
  it('C: created credit_note row has company_id = calling company', async () => {
    const cn = await createCreditNote(
      COMPANY_A,
      {
        type: 'customer',
        clientId: customerA,
        creditDate: '2026-04-15',
        reason: 'BL-42 scope check',
        subtotal: 50,
        taxRate: 15,
      },
      USER_ID,
    );
    createdIds.push(cn.id);

    const rows = await sql`
      SELECT company_id FROM credit_notes WHERE id = ${cn.id}::UUID
    ` as Array<{ company_id: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].company_id).toBe(COMPANY_A);
  });
});
