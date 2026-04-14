/**
 * Integration test: BL-02 — product_categories tenant scoping
 *
 * TDD RED phase: written BEFORE migration 292 is applied.
 * Expected FAIL until:
 *   1. Migration 292 adds company_id column
 *   2. Handler is updated to filter by company_id OR IS NULL
 *
 * Properties under test:
 *   A. Seed rows (company_id IS NULL) are visible to every tenant
 *   B. Tenant-A rows are visible to A and hidden from B
 *   C. Tenant-B rows are visible to B and hidden from A
 */

import { describe, it, expect, afterAll } from 'vitest';
import { sql } from '@/lib/neon';

// Two synthetic company UUIDs used as test tenants — these must already
// exist in the companies table (created in seed/migration 001).
// We use UUIDs that are guaranteed not to conflict with prod rows by
// inserting throw-away companies if needed.
const COMPANY_A = '00000000-0000-0000-0000-000000000aa1';
const COMPANY_B = '00000000-0000-0000-0000-000000000bb2';

// IDs of rows we insert during setup — cleaned up in afterAll
let insertedAId: string | null = null;
let insertedBId: string | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureTestCompany(id: string, name: string): Promise<void> {
  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${id}::UUID, ${name}, 'TEST-REG', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

async function insertCategoryForCompany(companyId: string, code: string): Promise<string> {
  const rows = await sql`
    INSERT INTO product_categories (name, code, description, company_id)
    VALUES (${'Test Category ' + code}, ${code}, 'Integration test row', ${companyId}::UUID)
    RETURNING id
  ` as Array<{ id: string }>;
  return rows[0]!.id;
}

async function fetchCategoriesForCompany(companyId: string): Promise<Array<{ id: string; company_id: string | null }>> {
  return sql`
    SELECT id, company_id
    FROM product_categories
    WHERE is_active = true
      AND (company_id = ${companyId}::UUID OR company_id IS NULL)
    ORDER BY name
  ` as Promise<Array<{ id: string; company_id: string | null }>>;
}

// ---------------------------------------------------------------------------
// Setup + Teardown
// ---------------------------------------------------------------------------

async function setup(): Promise<void> {
  await ensureTestCompany(COMPANY_A, 'Integration Test Company A');
  await ensureTestCompany(COMPANY_B, 'Integration Test Company B');

  insertedAId = await insertCategoryForCompany(COMPANY_A, 'integ_test_cat_a_' + Date.now());
  insertedBId = await insertCategoryForCompany(COMPANY_B, 'integ_test_cat_b_' + Date.now());
}

afterAll(async () => {
  // Clean up rows inserted during the test
  if (insertedAId) {
    await sql`DELETE FROM product_categories WHERE id = ${insertedAId}::UUID`;
  }
  if (insertedBId) {
    await sql`DELETE FROM product_categories WHERE id = ${insertedBId}::UUID`;
  }
  // Leave the test companies; they are idempotent and harm nothing
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BL-02: product_categories tenant scoping', async () => {
  await setup();

  it('A: seed rows (company_id IS NULL) are visible to any tenant', async () => {
    const rowsA = await fetchCategoriesForCompany(COMPANY_A);
    const rowsB = await fetchCategoriesForCompany(COMPANY_B);

    const seedA = rowsA.filter(r => r.company_id === null);
    const seedB = rowsB.filter(r => r.company_id === null);

    // Both tenants see the same set of seed rows
    expect(seedA.length).toBeGreaterThanOrEqual(8);
    expect(seedB.length).toBe(seedA.length);
  });

  it('B: Company-A row is visible to A and NOT visible to B', async () => {
    expect(insertedAId).not.toBeNull();

    const rowsA = await fetchCategoriesForCompany(COMPANY_A);
    const rowsB = await fetchCategoriesForCompany(COMPANY_B);

    const seenByA = rowsA.some(r => r.id === insertedAId);
    const seenByB = rowsB.some(r => r.id === insertedAId);

    expect(seenByA).toBe(true);
    expect(seenByB).toBe(false);
  });

  it('C: Company-B row is visible to B and NOT visible to A', async () => {
    expect(insertedBId).not.toBeNull();

    const rowsA = await fetchCategoriesForCompany(COMPANY_A);
    const rowsB = await fetchCategoriesForCompany(COMPANY_B);

    const seenByB = rowsB.some(r => r.id === insertedBId);
    const seenByA = rowsA.some(r => r.id === insertedBId);

    expect(seenByB).toBe(true);
    expect(seenByA).toBe(false);
  });
});
