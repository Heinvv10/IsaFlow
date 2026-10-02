/**
 * D5 (Hein, 2026-10-02): whether an account with sub-accounts may be ASSIGNED a
 * role is decided by the same balance-sheet / income-statement split that
 * decides whether a holder may GAIN sub-accounts. Pinned without a database so
 * `bun run ci` (which skips the integration suite) goes red if it drifts.
 */
import { describe, it, expect } from 'vitest';
import { HOLDER_NO_CHILDREN_TYPES, isBalanceSheetType, roleBarringChildren, roleTargetRefusal } from '@/modules/accounting/services/gl/roleTargetRules';
import { GL_ACCOUNT_TYPES } from '@/modules/accounting/types/gl.types';

const header = (type: string) => ({ code: '9000', type, isActive: true, hasChildren: true, subtype: 'other' });

describe('roleTargetRefusal: a header as the target', () => {
  it('admits an income-statement role (default revenue, cost of sales, other income, admin expense)', () => {
    expect({
      default_revenue: roleTargetRefusal('default_revenue', 'sales_revenue', header('revenue')),
      default_expense: roleTargetRefusal('default_expense', 'cost_of_sales', header('expense')),
      other_income: roleTargetRefusal('other_income', 'other_income', header('revenue'), 'import'),
      admin_expense: roleTargetRefusal('admin_expense', 'admin_expense', header('expense'), 'reactivate'),
    }).toEqual({ default_revenue: null, default_expense: null, other_income: null, admin_expense: null });
  });

  it('refuses a balance-sheet role (bank, receivable, payable, retained earnings), for every caller', () => {
    for (const caller of ['save', 'import', 'reactivate'] as const) {
      for (const [role, type] of [['bank', 'asset'], ['receivable', 'asset'], ['payable', 'liability'], ['retained_earnings', 'equity']]) {
        expect(roleTargetRefusal(role, role, header(type), caller), `${caller} ${role}`).toMatch(/9000 (is a header with|has) sub-accounts.*balance-sheet role/);
      }
    }
  });

  it('is the same predicate as the one barring a holder from gaining sub-accounts', () => {
    for (const [role, type] of [['bank', 'asset'], ['payable', 'liability'], ['retained_earnings', 'equity'], ['default_revenue', 'revenue'], ['default_expense', 'expense']]) {
      const barsChildren = roleBarringChildren({ account_type: type, account_subtype: role, is_system_account: true }) !== null;
      const barsAssignment = roleTargetRefusal(role, role, header(type)) !== null;
      expect({ role, barsAssignment }).toEqual({ role, barsAssignment: barsChildren });
    }
  });
});

describe('the balance-sheet split: one definition for the function and the SQL list', () => {
  it('HOLDER_NO_CHILDREN_TYPES (bound into SQL) is exactly the account types isBalanceSheetType admits', () => {
    for (const type of [...GL_ACCOUNT_TYPES, 'other', '', 'ASSET', undefined, null]) {
      expect({ type, inList: (HOLDER_NO_CHILDREN_TYPES as readonly unknown[]).includes(type) })
        .toEqual({ type, inList: isBalanceSheetType(type) });
    }
  });

  it('is asset, liability and equity', () => {
    expect([...HOLDER_NO_CHILDREN_TYPES].sort()).toEqual(['asset', 'equity', 'liability']);
  });
});
