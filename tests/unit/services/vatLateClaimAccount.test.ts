/**
 * The late-claim clearing account (migration 701) is OUTSIDE the VAT class:
 * nothing that decides "is this VAT?" may read it as VAT, or the original half
 * of a split would still be refused by the lock and would still land in the
 * filed period's return.
 */
import { describe, expect, it } from 'vitest';
import { reportingClassFor } from '@/modules/accounting/services/gl/accountReportingClass';
import { canonicalSubtype } from '@/modules/accounting/services/gl/accountSubtypes';
import { lineMovesVatFigure } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { SYSTEM_ACCOUNT_KEYS } from '@/modules/accounting/services/gl/systemAccountKeys';
import { GL_ACCOUNT_SUBTYPES_BY_TYPE, SYSTEM_RESERVED_SUBTYPES } from '@/modules/accounting/types/glAccountSubtypes';

const SUBTYPE = 'vat_input_late_claim';

describe('vat_input_late_claim', () => {
  it('is an ordinary account, not VAT class', () => {
    expect(reportingClassFor(SUBTYPE)).toBe('ordinary');
    // Classified (the census reports no unclassified account), and as ITSELF — not a VAT control subtype.
    expect(canonicalSubtype(SUBTYPE)).toBe('vat_input_late_claim');
  });

  it('an untagged line on it moves no VAT figure (the lock lets the original post)', () => {
    expect(lineMovesVatFigure(null, SUBTYPE)).toBe(false);
  });

  it('is a system role, reserved, and legal only on an asset', () => {
    expect(SYSTEM_ACCOUNT_KEYS).toContain(SUBTYPE);
    expect(SYSTEM_RESERVED_SUBTYPES).toContain(SUBTYPE);
    expect(GL_ACCOUNT_SUBTYPES_BY_TYPE.asset as readonly string[]).toContain(SUBTYPE);
    expect(GL_ACCOUNT_SUBTYPES_BY_TYPE.liability as readonly string[]).not.toContain(SUBTYPE);
  });
});
