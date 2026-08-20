/**
 * The pure logic added by the non-VAT-vendor change that had no coverage:
 * API input validation, the settings deep-link parser, the library tile
 * swap, and the VAT basis normaliser feeding the AFS accounting-policy notes.
 */
import { describe, it, expect } from 'vitest';
import { isValidVatPeriod, isValidVatSystemType } from '@/../pages/api/accounting/companies';
import { parseTabId, TAB_IDS } from '@/components/accounting/settings/settingsNav';
import { libraryModulesFor, LIBRARY_MODULES } from '@/components/accounting/navSections/library';
import { normalizeVatBasis, isVatRegistered } from '@/modules/bureau/services/vatPeriodHelper';

describe('isValidVatPeriod', () => {
  it('accepts the three real cadences, case- and space-insensitively', () => {
    for (const v of ['monthly', 'bi-monthly', 'none', 'Bi-Monthly', ' none ']) {
      expect(isValidVatPeriod(v)).toBe(true);
    }
  });

  it('treats absent as valid — the column is optional on update', () => {
    expect(isValidVatPeriod(undefined)).toBe(true);
    expect(isValidVatPeriod(null)).toBe(true);
    expect(isValidVatPeriod('')).toBe(true);
  });

  it('rejects junk that would silently read as bi-monthly', () => {
    expect(isValidVatPeriod('quarterly')).toBe(false);
    expect(isValidVatPeriod('bimonthly')).toBe(false);
    expect(isValidVatPeriod(2)).toBe(false);
    expect(isValidVatPeriod({})).toBe(false);
  });
});

describe('isValidVatSystemType', () => {
  it('accepts the three real values', () => {
    for (const v of ['invoice', 'payment', 'none', 'Invoice']) {
      expect(isValidVatSystemType(v)).toBe(true);
    }
  });

  it('rejects junk that would silently read as registered', () => {
    expect(isValidVatSystemType('cash')).toBe(false);
    expect(isValidVatSystemType('not-registered')).toBe(false);
    expect(isValidVatSystemType(7)).toBe(false);
  });
});

describe('parseTabId', () => {
  it('accepts every real settings tab id', () => {
    expect(TAB_IDS).toContain('vat');
    for (const id of TAB_IDS) expect(parseTabId(id)).toBe(id);
  });

  it('rejects anything that is not a tab id', () => {
    expect(parseTabId('vat; drop table')).toBeNull();
    expect(parseTabId('VAT')).toBeNull();
    expect(parseTabId(undefined)).toBeNull();
    expect(parseTabId(['vat'])).toBeNull();
  });
});

describe('libraryModulesFor', () => {
  it('leaves the grid untouched for a VAT vendor', () => {
    expect(libraryModulesFor(true)).toBe(LIBRARY_MODULES);
  });

  it('repoints the Tax tile away from the VAT return for a non-vendor', () => {
    const tax = libraryModulesFor(false).find((m) => m.id === 'tax')!;
    expect(tax.href).toBe('/accounting/sars');
    expect(tax.description).not.toMatch(/VAT/);
  });

  it('changes nothing else', () => {
    const before = LIBRARY_MODULES.filter((m) => m.id !== 'tax');
    const after = libraryModulesFor(false).filter((m) => m.id !== 'tax');
    expect(after).toEqual(before);
  });
});

describe('normalizeVatBasis', () => {
  it('only ever yields a real accounting basis', () => {
    expect(normalizeVatBasis('payment')).toBe('payment');
    expect(normalizeVatBasis('Payment')).toBe('payment');
    expect(normalizeVatBasis('invoice')).toBe('invoice');
    expect(normalizeVatBasis(null)).toBe('invoice');
    // 'none' is not a basis — callers must check isVatRegistered first.
    expect(normalizeVatBasis('none')).toBe('invoice');
    expect(normalizeVatBasis('garbage')).toBe('invoice');
  });

  it('pairs with isVatRegistered so a non-vendor is never given a basis', () => {
    expect(isVatRegistered('none', 'invoice')).toBe(false);
    expect(isVatRegistered('bi-monthly', 'none')).toBe(false);
  });
});
