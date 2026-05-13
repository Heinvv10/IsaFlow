/**
 * Unit tests for nlQueryValidationService.
 *
 * Covers the two security fixes:
 *  1. UNION / UNION ALL exfiltration — both forms must be rejected.
 *  2. Subquery table-allowlist bypass — forbidden tables inside WHERE EXISTS
 *     (or any nested subquery) must be caught regardless of paren depth.
 */

import { describe, it, expect } from 'vitest';
import { validateGeneratedSQL } from '@/modules/accounting/services/core/nlQueryValidationService';

const OWN_COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const VICTIM_COMPANY = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// A minimal valid base query used across several tests.
const VALID_BASE = `SELECT id, amount FROM customer_invoices WHERE company_id = '${OWN_COMPANY}'`;

describe('validateGeneratedSQL — UNION / UNION ALL exfiltration', () => {
  it('accepts a well-formed SELECT with no UNION', () => {
    const result = validateGeneratedSQL(VALID_BASE);
    expect(result.valid).toBe(true);
  });

  it('rejects UNION (without ALL)', () => {
    const sql = `${VALID_BASE} UNION SELECT id, amount FROM customer_invoices WHERE company_id = '${VICTIM_COMPANY}'`;
    const result = validateGeneratedSQL(sql);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/UNION/i);
  });

  it('rejects UNION ALL', () => {
    const sql = `${VALID_BASE} UNION ALL SELECT id, amount FROM customer_invoices WHERE company_id = '${VICTIM_COMPANY}'`;
    const result = validateGeneratedSQL(sql);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/UNION/i);
  });

  it('rejects UNION ALL even when own company_id appears first (bypasses scope check)', () => {
    // This is the specific attack: own company_id appears in the first leg so
    // the scope regex in nl-query.ts would pass, but the second leg targets a
    // different tenant.
    const sql =
      `SELECT id FROM customers WHERE company_id = '${OWN_COMPANY}' ` +
      `UNION ALL SELECT id FROM customers WHERE company_id = '${VICTIM_COMPANY}'`;
    const result = validateGeneratedSQL(sql);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/UNION/i);
  });
});

describe('validateGeneratedSQL — subquery table-allowlist bypass', () => {
  it('rejects a forbidden table referenced in WHERE EXISTS subquery', () => {
    // pg_catalog or any other system/forbidden table inside a nested SELECT
    // should be caught even though it is at paren depth > 0.
    const sql =
      `SELECT id FROM customers WHERE company_id = '${OWN_COMPANY}' ` +
      `AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public')`;
    const result = validateGeneratedSQL(sql);
    // pg_ reference is caught by FORBIDDEN_PATTERNS — the test asserts
    // the query is rejected for any reason (UNION fix adds table-walk safety).
    expect(result.valid).toBe(false);
  });

  it('rejects a non-allowlisted table inside a subquery at depth > 0', () => {
    // Use a plausible but non-allowlisted table name that won't trigger other
    // forbidden keyword checks — only the table allowlist should catch it.
    const sql =
      `SELECT id FROM customers WHERE company_id = '${OWN_COMPANY}' ` +
      `AND EXISTS (SELECT 1 FROM schema_migrations WHERE id = customers.id)`;
    const result = validateGeneratedSQL(sql);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/schema_migrations.*not allowed/i);
  });

  it('accepts an allowed table in a subquery at depth > 0', () => {
    const sql =
      `SELECT c.id FROM customers c WHERE c.company_id = '${OWN_COMPANY}' ` +
      `AND EXISTS (SELECT 1 FROM customer_invoices ci WHERE ci.customer_id = c.id AND ci.company_id = '${OWN_COMPANY}')`;
    const result = validateGeneratedSQL(sql);
    expect(result.valid).toBe(true);
  });

  it('accepts a CTE alias that shadows a non-allowlisted name', () => {
    // The CTE is named something not in ALLOWED_TABLES; the alias should be
    // permitted because it resolves to a CTE, not a real table.
    const sql =
      `WITH summary AS (SELECT id FROM customers WHERE company_id = '${OWN_COMPANY}') ` +
      `SELECT id FROM summary`;
    const result = validateGeneratedSQL(sql);
    expect(result.valid).toBe(true);
  });
});
