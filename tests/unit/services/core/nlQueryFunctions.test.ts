import { describe, expect, it } from 'vitest';
import { ALLOWED_TABLES, validateGeneratedSQL } from '@/modules/accounting/services/core/nlQueryValidationService';

const own = "WHERE company_id = '11111111-1111-1111-1111-111111111111'";

describe('R-004 NL query function capability gate', () => {
  it.each([
    "SELECT query_to_xml('SELECT secret FROM webhook_endpoints', true, false, '')",
    "SELECT table_to_xml('webhook_endpoints', true, false, '')",
    "SELECT xpath('/row/secret/text()', query_to_xml('SELECT secret FROM webhook_endpoints', true, false, ''))",
    'SELECT lo_get(123)',
    "SELECT public.query_to_xml('SELECT 1', true, false, '')",
    "SELECT \"query_to_xml\"('SELECT 1', true, false, '')",
    `SELECT name, (SELECT query_to_xml('SELECT 1', true, false, '')) FROM customers ${own}`,
    `SELECT name FROM customers ${own} AND length(query_to_xml('SELECT 1', true, false, '')::text) > 0`,
    `WITH c AS (SELECT query_to_xml('SELECT 1', true, false, '') AS x) SELECT x FROM c`,
    `SELECT public.count(*) FROM customers ${own}`,
  ])('rejects %s', (sql) => {
    const result = validateGeneratedSQL(sql);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/not allowed|schema/i);
  });

  it.each([
    `SELECT count(*), sum(total_amount), avg(total_amount), min(invoice_date), max(invoice_date) FROM customer_invoices ${own}`,
    `SELECT coalesce(amount_paid, 0), nullif(total_amount, 0), greatest(total_amount, 0), least(total_amount, 0) FROM customer_invoices ${own}`,
    `SELECT date_trunc('month', invoice_date), extract(month from invoice_date), to_char(invoice_date, 'YYYY-MM'), age(due_date, invoice_date), now(), current_date FROM customer_invoices ${own}`,
    `SELECT lower(name), upper(name), trim(name), length(name), substring(name from 1 for 3), left(name, 3), concat(name, 'x'), split_part(name, ' ', 1) FROM customers ${own}`,
    `SELECT round(total_amount, 2), abs(total_amount), ceil(total_amount), floor(total_amount), total_amount::numeric FROM customer_invoices ${own}`,
    `SELECT string_agg(name, ', ' ORDER BY name), array_agg(name) FROM customers ${own}`,
    `SELECT name, row_number() OVER (ORDER BY name), rank() OVER (ORDER BY name), sum(1) OVER () FROM customers ${own}`,
    `SELECT name FROM customers ${own} AND id = ANY(ARRAY['a']) AND EXISTS (SELECT 1 FROM customer_invoices ci WHERE ci.company_id = '11111111-1111-1111-1111-111111111111')`,
    `SELECT CASE WHEN status = 'paid' THEN 1 ELSE 0 END, status LIKE 'p%', status IN ('a', 'b'), total_amount BETWEEN 1 AND 2 FROM customer_invoices ${own}`,
  ])('accepts analytical %s', (sql) => {
    expect(validateGeneratedSQL(sql)).toMatchObject({ valid: true });
  });
});

describe('R-004 review follow-ups', () => {
  it.each([
    "SELECT 16384::regclass::text",
    "SELECT 'customers'::regclass::oid::text",
    'SELECT 10::regrole::text',
    'SELECT current_user',
    'SELECT session_user',
    'SELECT user',
    "SELECT repeat('a', 400000000)",
    "SELECT lpad('a', 400000000, 'b')",
  ])('rejects %s', (sql) => {
    expect(validateGeneratedSQL(sql).valid).toBe(false);
  });
});

describe('R-004 allowlist boundaries', () => {
  it('keeps webhook_endpoints outside the relation allowlist', () => {
    expect(ALLOWED_TABLES.has('webhook_endpoints')).toBe(false);
  });
  it.each([
    "SELECT json_agg(name), array_to_string(array_agg(name), ','), md5(name), width_bucket(total_amount, 0, 1000, 10), corr(total_amount, amount_paid), format('%s', name), regexp_matches(name, 'a') FROM customer_invoices ci JOIN customers c ON c.id = ci.customer_id WHERE ci.company_id = '11111111-1111-1111-1111-111111111111' AND c.company_id = '11111111-1111-1111-1111-111111111111'",
  ])('accepts common analytical additions %s', (sql) => {
    expect(validateGeneratedSQL(sql)).toMatchObject({ valid: true });
  });
  it.each(['SELECT version()', "SELECT current_setting('x')", "SELECT xmlexists('/a' PASSING BY REF '<a/>')", 'SELECT random()', 'SELECT clock_timestamp()'])('still rejects %s', (sql) => {
    expect(validateGeneratedSQL(sql).valid).toBe(false);
  });
});
