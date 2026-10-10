/**
 * The TypeScript statement of migration 888 (entityChangeTypes.ts,
 * entityChangeMasking.ts) pinned to the migration, and the masking itself.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../helpers/sourceCensus';
import {
  ADMIN_ROLES, CHANNELS, ENTITY_TYPES, isHistoryAdmin, mayReadType,
} from '@/modules/accounting/services/core/entityChanges/entityChangeTypes';
import { changeFields, maskValue, SENSITIVE_FIELDS } from '@/modules/accounting/services/core/entityChanges/entityChangeMasking';
import { entityLabel } from '@/modules/accounting/services/core/entityChanges/entityChangeQuery';

const SQL = readFileSync(path.join(ROOT, 'scripts/migrations/sql/888_entity_change_history.sql'), 'utf8');
const quoted = (block: string) => [...block.matchAll(/'(\w+)'/g)].map((m) => m[1]!);

describe('888 and its TypeScript agree', () => {
  it('entity types: the CHECK, the trigger list and ENTITY_TYPES', () => {
    const check = /entity_type\s+TEXT NOT NULL CHECK \(entity_type IN \(([\s\S]*?)\)\)/.exec(SQL)![1]!;
    expect(quoted(check).sort()).toEqual([...ENTITY_TYPES].sort());
    const values = /FROM \(VALUES([\s\S]*?)\) v\(tbl, typ\)/.exec(SQL)![1]!;
    expect([...values.matchAll(/\('\w+', '(\w+)'\)/g)].map((m) => m[1]).sort()).toEqual([...ENTITY_TYPES].sort());
  });

  it('channels: the CHECK and CHANNELS', () => {
    const check = /channel\s+TEXT NOT NULL CHECK \(channel IN \(([^)]*)\)\)/.exec(SQL)![1]!;
    expect(quoted(check).sort()).toEqual([...CHANNELS].sort());
  });

  it('who reads what: the RLS policy and mayReadType', () => {
    const policy = /CREATE POLICY entity_changes_read[\s\S]*?END\);/.exec(SQL)![0];
    const memberTypes = quoted(/WHEN entity_type IN \(([^)]*)\) THEN true/.exec(policy)![1]!);
    const payrollRoles = quoted(/'payroll_employee'\s+THEN COALESCE\(public\.company_member_actor_role\(company_id\) IN \(([^)]*)\)/.exec(policy)![1]!);
    const otherRoles = quoted(/ELSE COALESCE\(public\.company_member_actor_role\(company_id\) IN \(([^)]*)\)/.exec(policy)![1]!);
    expect(otherRoles).toEqual(ADMIN_ROLES);
    for (const role of ['owner', 'admin', 'manager', 'viewer', 'accountant', undefined]) {
      for (const type of ENTITY_TYPES) {
        const expected = memberTypes.includes(type) || (type === 'payroll_employee'
          ? payrollRoles.includes(role ?? '') : otherRoles.includes(role ?? ''));
        expect(mayReadType(role, type), `${role} ${type}`).toBe(expected);
      }
      expect(isHistoryAdmin(role)).toBe(otherRoles.includes(role ?? ''));
    }
  });

  it('a masked field is never one the projection drops', () => {
    const projection = /CREATE OR REPLACE FUNCTION public\.entity_change_projection[\s\S]*?\n\$\$;/.exec(SQL)![0];
    const dropped = quoted(projection.slice(projection.indexOf('ELSE p_row')));
    expect(dropped).toEqual(expect.arrayContaining(['id', 'created_at', 'updated_at', 'bank_details_setters', 'token']));
    for (const fields of Object.values(SENSITIVE_FIELDS)) for (const f of fields) expect(dropped).not.toContain(f);
    const companyAllow = /e\.key = ANY \(ARRAY\[([\s\S]*?)\]::pg_catalog\.text\[\]\)/.exec(SQL)![1]!;
    for (const f of SENSITIVE_FIELDS.company) expect(quoted(companyAllow)).toContain(f);
  });

  // Blind review r2 L-1: the whole allow-list is pinned, so dropping any column fails here (not only the five the
  // capture suite writes).
  it('companies record exactly this allow-list (plus the two Netcash key digests)', () => {
    const allow = quoted(/e\.key = ANY \(ARRAY\[([\s\S]*?)\]::pg_catalog\.text\[\]\)/.exec(SQL)![1]!);
    expect([...allow].sort()).toEqual([
      'bank_account_number', 'bank_account_type', 'bank_branch_code', 'bank_name', 'billing_email', 'chase_auto_send_enabled',
      'client_query_whatsapp', 'credit_note_email_body', 'credit_note_email_signature', 'credit_note_email_subject',
      'default_currency', 'email', 'email_always_cc', 'email_use_for_communication', 'entity_type', 'financial_year_start',
      'functional_currency', 'fx_documents_enabled', 'idle_timeout_minutes', 'invoice_email_body', 'invoice_email_signature',
      'invoice_email_subject', 'is_active', 'lockdown_date', 'lockdown_enabled', 'mobile', 'name', 'netcash_enabled',
      'paye_reference_number', 'phone', 'portal_allow_payments', 'portal_payment_instructions', 'portal_welcome_message',
      'quote_email_body', 'quote_email_signature', 'quote_email_subject', 'recurring_invoice_email_body',
      'recurring_invoice_email_signature', 'recurring_invoice_email_subject', 'registered_name', 'registration_number',
      'sales_order_email_body', 'sales_order_email_signature', 'sales_order_email_subject', 'sdl_reference_number',
      'share_anonymised_signals', 'statement_email_body', 'statement_email_signature', 'statement_email_subject', 'status',
      'tax_number', 'tax_office', 'tax_practitioner_name', 'tax_practitioner_reg_number', 'trading_name',
      'uif_reference_number', 'vat_number', 'vat_period', 'vat_period_alignment', 'vat_system_type', 'whatsapp_chase_enabled',
    ]);
  });

  // Hein's decision 2: exactly these are masked (blind review L3 — dropping one must fail here).
  it('masks exactly the bank account and ID / tax numbers', () => {
    expect(SENSITIVE_FIELDS).toEqual({
      supplier: ['bank_account_number'],
      customer: [],
      gl_account: ['bank_account_number'],
      payroll_employee: ['id_number', 'passport_number', 'tax_number', 'tax_directive_number', 'uif_number'],
      company_user: [],
      company_invitation: [],
      company_user_permission: [],
      company: ['bank_account_number', 'tax_number', 'paye_reference_number', 'sdl_reference_number', 'uif_reference_number'],
      approval_rule: [],
      approval_enforcement: [],
    });
  });

});

describe('masking', () => {
  it('keeps the last four, hides four or fewer, passes empties through', () => {
    expect(maskValue('1234567890')).toBe('…7890');
    expect(maskValue(' 8001015009087 ')).toBe('…9087');
    expect(maskValue('1234')).toBe('••••');
    expect(maskValue(12345678)).toBe('…5678');
    expect(maskValue(null)).toBeNull();
    expect(maskValue('')).toBe('');
  });

  it('masks only the sensitive keys of the type, unless revealed', () => {
    const before = { bank_account_number: '1111222233', email: 'a@x' };
    const after = { bank_account_number: '9999888877', email: 'b@x' };
    expect(changeFields('supplier', ['bank_account_number', 'email'], before, after)).toEqual([
      { key: 'bank_account_number', before: '…2233', after: '…8877', masked: true },
      { key: 'email', before: 'a@x', after: 'b@x', masked: false },
    ]);
    expect(changeFields('customer', ['bank_account_number'], before, after)[0]!.masked).toBe(false);
    expect(changeFields('supplier', ['bank_account_number'], before, after, true)[0]).toEqual(
      { key: 'bank_account_number', before: '1111222233', after: '9999888877', masked: false });
    expect(changeFields('payroll_employee', ['id_number'], null, { id_number: '8001015009087' })[0]).toEqual(
      { key: 'id_number', before: null, after: '…9087', masked: true });
  });
});

describe('labels', () => {
  it('names the entity from what was recorded', () => {
    expect(entityLabel('gl_account', { before: null, after: { account_code: '1000', account_name: 'Bank' }, subject_name: null }))
      .toBe('1000 Bank');
    expect(entityLabel('payroll_employee', { before: { first_name: 'A', last_name: 'B' }, after: null, subject_name: null })).toBe('A B');
    expect(entityLabel('company_user', { before: null, after: { user_id: 'u1' }, subject_name: 'Jo' })).toBe('Jo');
    expect(entityLabel('company_user', { before: null, after: { user_id: 'u1' }, subject_name: null })).toBe('u1');
    expect(entityLabel('company_invitation', { before: null, after: { email: 'i@x' }, subject_name: null })).toBe('i@x');
    expect(entityLabel('supplier', { before: null, after: { name: '' }, subject_name: null })).toBeNull();
  });
});
