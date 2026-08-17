// tests/unit/components/customerEmails.test.ts
//
// The bulk customer-statement screen read `custJson.data.customers`, but
// GET /api/accounting/customers returns the rows as a BARE ARRAY
// (`apiResponse.success(res, rows)`). `.customers` was always undefined, so the
// email lookup stayed empty, every customer appeared to have no email, and the
// bulk-email feature could never select anyone. No crash, no error message — the
// feature just never worked.
//
// Confirmed by the sibling page: pages/accounting/customers/index.tsx reads the
// same endpoint as `(json.data ?? json) as Customer[]`, i.e. a bare array.
//
// Both shapes are accepted on purpose — the customer-statements endpoint DOES
// wrap its rows in `{ customers: [...] }`, and the two payloads are consumed
// side by side in the same function.

import { describe, it, expect } from 'vitest';
import { buildCustomerEmailMap, toCustomerRows } from '@/components/accounting/statements/customerEmails';

const ROWS = [
  { id: 'c1', email: 'one@example.com' },
  { id: 'c2', email: null },
  { id: 'c3' },
];

describe('toCustomerRows', () => {
  it('accepts the BARE ARRAY that /api/accounting/customers actually returns', () => {
    expect(toCustomerRows(ROWS)).toHaveLength(3);
  });

  it('accepts the { customers: [...] } wrapper the statements endpoint returns', () => {
    expect(toCustomerRows({ customers: ROWS })).toHaveLength(3);
  });

  it('returns [] for null/undefined rather than throwing', () => {
    expect(toCustomerRows(null)).toEqual([]);
    expect(toCustomerRows(undefined)).toEqual([]);
  });

  it('returns [] for a wrapper whose customers key is missing', () => {
    expect(toCustomerRows({})).toEqual([]);
  });
});

describe('buildCustomerEmailMap', () => {
  it('maps ids to emails from a bare array — the case that was broken', () => {
    const m = buildCustomerEmailMap(ROWS);
    expect(m.get('c1')).toBe('one@example.com');
    expect(m.size).toBe(3);
  });

  it('maps ids to emails from the wrapped shape too', () => {
    expect(buildCustomerEmailMap({ customers: ROWS }).get('c1')).toBe('one@example.com');
  });

  it('normalises a missing or null email to null, not undefined', () => {
    const m = buildCustomerEmailMap(ROWS);
    expect(m.get('c2')).toBeNull();
    expect(m.get('c3')).toBeNull();
  });

  it('skips a row with no id instead of keying it under undefined', () => {
    const m = buildCustomerEmailMap([{ id: '', email: 'x@y.z' }, ...ROWS]);
    expect(m.has('')).toBe(false);
    expect(m.size).toBe(3);
  });

  it('reproduces the original bug: reading .customers off a bare array yields nothing', () => {
    // What the page used to do. Kept executable so the failure mode stays legible.
    const asWrapper = ROWS as unknown as { customers?: typeof ROWS };
    expect(asWrapper.customers).toBeUndefined();
    expect((asWrapper.customers ?? []).length).toBe(0);
  });
});
