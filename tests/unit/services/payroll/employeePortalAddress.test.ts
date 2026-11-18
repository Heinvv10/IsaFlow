import { describe, expect, it } from 'vitest';
import { normalisePortalEmail } from '@/modules/accounting/services/payroll/employeePortalAddress';

describe('normalisePortalEmail (review #1570 M1)', () => {
  it('trims, folds compatibility forms and lowercases to one ASCII spelling', () => {
    expect(normalisePortalEmail('  Thandi.M@Example.INVALID ')).toBe('thandi.m@example.invalid');
    expect(normalisePortalEmail('Ｔｈａｎｄｉ@example.invalid')).toBe('thandi@example.invalid');
  });

  it('refuses whatever is not plain ASCII after that, and a blank', () => {
    for (const raw of ['wİlliam@example.invalid', 'zoë@example.invalid', 'a​@example.invalid', '   ']) {
      expect(normalisePortalEmail(raw)).toBeNull();
    }
  });
});
