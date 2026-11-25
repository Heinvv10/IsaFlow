/**
 * Wave 7 EA1: the address checks follow the SARS BRS PAYE Employer Reconciliation V25.3.0 rules for 3211-3217, 3285
 * (pp. 34-35) and 3288-3294 (pp. 36-40), and the printed lines.
 */
import { describe, expect, it } from 'vitest';
import {
  parseEmployeeAddress, postalLines, residentialLines, type EmployeeAddress,
} from '@/modules/accounting/services/payroll/payrollEmployeeAddressInput';

const RES = { unitNumber: '4', complex: 'Oak Court', streetNumber: '12', street: 'Main Road', suburb: 'Hatfield', city: 'Pretoria', postalCode: '0028', countryCode: 'ZA' };
const body = (residential: Record<string, unknown> = RES, postal: Record<string, unknown> = { sameAsResidential: true }) => ({ residential, postal });
const errors = (raw: unknown) => {
  const r = parseEmployeeAddress(raw);
  if (r.ok) throw new Error('expected a refusal');
  return r.fieldErrors;
};

describe('parseEmployeeAddress', () => {
  it('accepts a full ZA residential address with postal = residential (3288 = 1)', () => {
    const r = parseEmployeeAddress(body());
    expect(r).toEqual({ ok: true, address: { residential: RES, postal: { sameAsResidential: true } } });
  });

  it('trims, upper-cases the country, turns blanks into null and curly apostrophes into the plain one', () => {
    const r = parseEmployeeAddress(body({ ...RES, unitNumber: '  ', complex: '', street: '  O’Reilly Street ', countryCode: 'za' }));
    expect(r.ok && r.address.residential).toEqual({ ...RES, unitNumber: null, complex: null, street: "O'Reilly Street", countryCode: 'ZA' });
  });

  it('3214 street is mandatory; 3215 or 3216 must be given', () => {
    expect(errors(body({ ...RES, street: ' ' }))['residential.street']).toEqual(['Street or farm name is required (code 3214)']);
    expect(errors(body({ ...RES, suburb: null, city: '' }))['residential.city']).toEqual(['Give a suburb or district, or a city or town (codes 3215 / 3216)']);
    expect(parseEmployeeAddress(body({ ...RES, suburb: null })).ok).toBe(true);
    expect(parseEmployeeAddress(body({ ...RES, city: null })).ok).toBe(true);
  });

  it('3217: a ZA postal code is four digits and not 0000; outside ZA it is optional', () => {
    for (const bad of ['28', '00280', 'A028', '0000']) {
      expect(errors(body({ ...RES, postalCode: bad }))['residential.postalCode'], bad).toEqual(['A South African postal code is four digits and not 0000 (code 3217)']);
    }
    expect(errors(body({ ...RES, postalCode: null }))['residential.postalCode']).toEqual(['Postal code is required for a South African address (code 3217)']);
    expect(parseEmployeeAddress(body({ ...RES, postalCode: null, countryCode: 'NA' })).ok).toBe(true);
    expect(parseEmployeeAddress(body({ ...RES, postalCode: 'SW1A 1AA', countryCode: 'GB' })).ok).toBe(true);
  });

  it('holds each BRS length (3211 AN8, 3212 FT26, 3214 FT26, 3215 FT33, 3216 FT21)', () => {
    expect(errors(body({ ...RES, unitNumber: '123456789' }))['residential.unitNumber']).toEqual(['Unit number is at most 8 characters (code 3211)']);
    expect(parseEmployeeAddress(body({ ...RES, street: 'x'.repeat(26) })).ok).toBe(true);
    expect(errors(body({ ...RES, street: 'x'.repeat(27) }))['residential.street']).toEqual(['Street or farm name is at most 26 characters (code 3214)']);
    expect(parseEmployeeAddress(body({ ...RES, suburb: 'x'.repeat(33) })).ok).toBe(true);
    expect(errors(body({ ...RES, suburb: 'x'.repeat(34) }))['residential.suburb']).toEqual(['Suburb or district is at most 33 characters (code 3215)']);
    expect(errors(body({ ...RES, city: 'x'.repeat(22) }))['residential.city']).toEqual(['City or town is at most 21 characters (code 3216)']);
  });

  it('refuses what the file format cannot carry: comma, pipe, double quote, line break, non-Latin-1, a formula lead-in', () => {
    for (const bad of ['Main, Road', 'Main|Road', 'Main "Road"', 'Main\nRoad']) {
      expect(errors(body({ ...RES, street: bad }))['residential.street'], JSON.stringify(bad))
        .toEqual(['Street or farm name may not hold a comma, a pipe, a double quote or a line break (code 3214)']);
    }
    expect(errors(body({ ...RES, street: 'Main Road ✓' }))['residential.street']).toEqual(['Street or farm name holds a character SARS cannot accept (code 3214)']);
    expect(errors(body({ ...RES, street: '=HYPERLINK(1)' }))['residential.street']).toEqual(['Street or farm name may not start with = + - or @ (code 3214)']);
    // AN: letters (accented too), digits, dash, space, apostrophe only.
    expect(parseEmployeeAddress(body({ ...RES, streetNumber: "12-A é'" })).ok).toBe(true);
    expect(errors(body({ ...RES, streetNumber: '12/A' }))['residential.streetNumber']).toEqual(["Street number may hold letters, digits, spaces, - and ' only (code 3213)"]);
    // FT accepts the BRS's free-text punctuation and accented letters.
    expect(parseEmployeeAddress(body({ ...RES, complex: "Ré's Court #2 (A/B) & Co." })).ok).toBe(true);
  });

  it('3285 country: two letters', () => {
    expect(errors(body({ ...RES, countryCode: 'ZAF' }))['residential.countryCode']).toEqual(['Country must be a two-letter code, e.g. ZA (code 3285)']);
    expect(errors(body({ ...RES, countryCode: undefined }))['residential.countryCode']).toEqual(['Country is required']);
  });

  it('postal structure 4: line 1 mandatory, FT35 lines, a ZA code of four digits (3289-3294)', () => {
    const postal = { sameAsResidential: false, line1: 'PO Box 1234', line2: 'Hatfield', line3: '', line4: null, postalCode: '0028', countryCode: 'ZA' };
    const r = parseEmployeeAddress(body(RES, postal));
    expect(r.ok && r.address.postal).toEqual({ ...postal, line3: null });
    expect(errors(body(RES, { ...postal, line1: '' }))['postal.line1']).toEqual(['Postal address line 1 is required (code 3289)']);
    expect(errors(body(RES, { ...postal, line2: 'x'.repeat(36) }))['postal.line2']).toEqual(['Postal address line 2 is at most 35 characters (code 3290)']);
    expect(errors(body(RES, { ...postal, postalCode: '0000' }))['postal.postalCode']).toEqual(['A South African postal code is four digits and not 0000 (code 3293)']);
    expect(errors(body(RES, { ...postal, countryCode: '' }))['postal.countryCode']).toEqual(['Country must be a two-letter code, e.g. ZA (code 3294)']);
  });

  it('refuses a body without both addresses', () => {
    expect(Object.keys(errors({ residential: RES }))).toEqual(['postal']);
    expect(Object.keys(errors({ postal: { sameAsResidential: true } }))).toEqual(['residential']);
    expect(parseEmployeeAddress(null).ok).toBe(false);
  });
});

describe('printed lines', () => {
  const address = (parseEmployeeAddress(body()) as { address: EmployeeAddress }).address;
  it('residential', () => {
    expect(residentialLines(address.residential)).toEqual(['Unit 4 Oak Court', '12 Main Road', 'Hatfield', 'Pretoria 0028', 'ZA']);
    expect(residentialLines({ ...address.residential, unitNumber: null, complex: null, streetNumber: null, suburb: null })).toEqual(['Main Road', 'Pretoria 0028', 'ZA']);
  });
  it('postal: the residential lines when the same, else its own', () => {
    expect(postalLines(address)).toEqual(residentialLines(address.residential));
    expect(postalLines({ ...address, postal: { sameAsResidential: false, line1: 'PO Box 9', line2: null, line3: 'Hatfield', line4: null, postalCode: '0028', countryCode: 'ZA' } }))
      .toEqual(['PO Box 9', 'Hatfield', '0028', 'ZA']);
  });
});
