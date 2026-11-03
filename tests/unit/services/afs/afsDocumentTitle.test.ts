import { describe, it, expect } from 'vitest';
import {
  afsDocumentTitle, afsDocumentNoun, packPeriodPhrase,
} from '@/modules/accounting/services/afs/afsDocumentTitle';

describe('afsDocumentTitle', () => {
  it('names a management pack and an AFS', () => {
    expect(afsDocumentTitle('management_pack')).toBe('Management Pack');
    expect(afsDocumentTitle('afs')).toBe('Annual Financial Statements');
  });
  it('an unknown or missing type is an AFS (the historical wording)', () => {
    expect(afsDocumentTitle(undefined)).toBe('Annual Financial Statements');
    expect(afsDocumentTitle(null)).toBe('Annual Financial Statements');
  });
  it('lower-case noun for running text', () => {
    expect(afsDocumentNoun('management_pack')).toBe('management pack');
    expect(afsDocumentNoun('afs')).toBe('annual financial statements');
  });
});

describe('packPeriodPhrase', () => {
  it('spells a YYYY-MM period as month name and year', () => {
    expect(packPeriodPhrase('2026-10')).toBe('month of October 2026');
    expect(packPeriodPhrase('2027-02')).toBe('month of February 2027');
  });
  it('leaves a value that is not YYYY-MM as the raw period', () => {
    expect(packPeriodPhrase('2026-13')).toBe('month of 2026-13');
    expect(packPeriodPhrase('Q3')).toBe('month of Q3');
  });
});
