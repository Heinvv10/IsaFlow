/**
 * The words of the role refusals, pinned WITHOUT a database so `bun run ci`
 * (which skips the integration suite) goes red if they drift. The Chart of
 * Accounts screen calls the field "subtype"; the refusals said "classified" /
 * "classification", a word the screen does not use, and told the user to
 * choose 'other' — which the subtype select must therefore offer.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()) }));
vi.mock('@/lib/alsTransaction', () => ({ withAlsTransaction: vi.fn((_a: unknown, fn: () => unknown) => fn()) }));
vi.mock('@/modules/accounting/services/core/migrationCoaVatLock', () => ({ accountAttributes: vi.fn(async () => new Map()), attributeChanges: vi.fn(() => []) }));
vi.mock('@/modules/accounting/services/gl/vatLockLineClassification', () => ({ assertAccountChangesKeepVatLocks: vi.fn(async () => undefined) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ clearSystemAccountCacheAfterCommit: vi.fn() }));
vi.mock('@/modules/accounting/services/core/migrationService', () => ({ updateSession: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/systemRoleInvariant', () => ({
  snapshotRoles: vi.fn(async () => ({})), assertRolesKept: vi.fn(async () => undefined),
  rolesNotKept: vi.fn(() => []), SystemRoleInvariantError: class extends Error {},
}));

import { sql } from '@/lib/neon';
import { roleTargetRefusal } from '@/modules/accounting/services/gl/roleTargetRules';
import { importChartOfAccounts } from '@/modules/accounting/services/core/migrationCoaService';
import { subtypeOptionsFor } from '@/components/accounting/dashboard/accountSubtypeOptions';
import { GL_ACCOUNT_TYPES } from '@/modules/accounting/types/gl.types';

const target = { code: '1140', type: 'asset', isActive: true, hasChildren: false, subtype: 'vat_input' };

describe('role refusal wording', () => {
  it('the Default Accounts save says "subtype", and what to change it to', () => {
    expect(roleTargetRefusal('bank', 'primary_bank', target)).toBe(
      "Account 1140 has the subtype 'vat_input'; only an account with the subtype 'other' (or none), or one that already has the subtype 'bank', "
      + "can hold that role. Change its subtype to 'other' first.");
  });

  it('the import adds where to do it and that the import can be run again', () => {
    const text = roleTargetRefusal('default_revenue', 'default_revenue', { ...target, code: '4200', type: 'revenue', subtype: 'revenue' }, 'import');
    expect(text).toMatch(/^Account 4200 has the subtype 'revenue'; .* Change its subtype to 'other' first\. Do that in Chart of Accounts: edit account 4200, set its subtype to 'other' and save — then run this import again\.$/);
  });

  it('neither says "classified" or "classification"', () => {
    for (const caller of ['save', 'import', 'reactivate'] as const) {
      expect(roleTargetRefusal('bank', 'bank', target, caller)).not.toMatch(/classif/i);
    }
  });

  it('the import\'s note on a system account it did not re-type says "type and subtype"', async () => {
    // The upsert's RETURNING: the row kept its own type and subtype, which differ from the file's.
    vi.mocked(sql as unknown as (s: TemplateStringsArray) => Promise<unknown[]>).mockImplementation(async (s) => (
      s.join('').includes('INSERT INTO gl_accounts') ? [{ account_type: 'asset', account_subtype: 'bank' }] : []));
    const out = await importChartOfAccounts('11111111-1111-4111-8111-111111111111', 'sess',
      [{ accountCode: '1110', accountName: 'Bank', accountType: 'expense', normalBalance: 'debit', accountSubtype: 'operating_expense' }], {});
    expect(out.errors.map((e) => e.message)).toEqual([
      'Account 1110 is a system account: its name was updated, its type and subtype (asset / bank) were kept.']);
  });

  it('the Chart tab\'s subtype select offers "other" for every account type — the value the refusal tells the user to choose', () => {
    expect(Object.fromEntries(GL_ACCOUNT_TYPES.map((t) => [t, subtypeOptionsFor(t).some((o) => o.value === 'other')])))
      .toEqual({ asset: true, liability: true, equity: true, revenue: true, expense: true });
  });
});
