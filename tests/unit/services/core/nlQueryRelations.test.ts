import { describe, expect, it } from 'vitest';
import { validateGeneratedSQL } from '@/modules/accounting/services/core/nlQueryValidationService';

describe('parsed NL query relation allowlist', () => {
  it.each([
    'SELECT * FROM "webhook_endpoints"',
    'SELECT * FROM customers, "webhook_endpoints"',
    'SELECT (SELECT secret FROM "webhook_endpoints") FROM customers',
    'SELECT * FROM private.customers',
    'SELECT * FROM "CUSTOMERS"',
    'WITH x AS (SELECT * FROM "webhook_endpoints") SELECT * FROM x',
    'SELECT * FROM "webhook_endpoints" WHERE EXISTS (WITH "webhook_endpoints" AS (SELECT * FROM customers) SELECT * FROM "webhook_endpoints")',
  ])('rejects unapproved relation: %s', sql => {
    expect(validateGeneratedSQL(sql).valid).toBe(false);
  });
  it.each([
    'SELECT * FROM "customers"',
    'SELECT * FROM public.customers',
    'SELECT * FROM "public"."customers"',
    'WITH a AS (SELECT * FROM customers), b AS (SELECT * FROM a) SELECT * FROM b',
    'SELECT * FROM (SELECT * FROM customers) AS c',
  ])('accepts approved relations: %s', sql => {
    expect(validateGeneratedSQL(sql).valid).toBe(true);
  });
});
