/**
 * The TypeScript statement of migration 890 (entityChangeTypes.ts,
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

const SQL = readFileSync(path.join(ROOT, 'scripts/migrations/sql/890_entity_change_history.sql'), 'utf8');
const quoted = (block: string) => [...block.matchAll(/'(\w+)'/g)].map((m) => m[1]!);

describe('890 and its TypeScript agree', () => {
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
    const dropped = ['id', 'created_at', 'updated_at', 'bank_details_setters', 'is_default', 'token'];
    for (const fields of Object.values(SENSITIVE_FIELDS)) for (const f of fields) expect(dropped).not.toContain(f);
    const companyAllow = /e\.key = ANY \(ARRAY\[([\s\S]*?)\]::pg_catalog\.text\[\]\)/.exec(SQL)![1]!;
    for (const f of SENSITIVE_FIELDS.company) expect(quoted(companyAllow)).toContain(f);
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
