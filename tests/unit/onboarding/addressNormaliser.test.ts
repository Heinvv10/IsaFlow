/**
 * Tests for the SA address normaliser used by /api/onboarding/extract to
 * rescue VLM extractions that dump multi-component addresses into one field.
 */

import { describe, it, expect } from 'vitest';
import {
  normaliseAddressFields,
  inferProvinceFromPostalCode,
} from '@/modules/onboarding/services/addressNormaliser';

describe('inferProvinceFromPostalCode', () => {
  const cases: Array<[string, string, string]> = [
    // code, expected province, description
    ['0001', 'Gauteng',       'Pretoria central'],
    ['0181', 'Gauteng',       'Pretoria Hatfield'],
    ['2000', 'Gauteng',       'Johannesburg CBD'],
    ['2196', 'Gauteng',       'Sandton'],
    ['2520', 'North West',    'Potchefstroom'],
    ['3200', 'KwaZulu-Natal', 'Pietermaritzburg'],
    ['4001', 'KwaZulu-Natal', 'Durban'],
    ['5200', 'Eastern Cape',  'East London'],
    ['6001', 'Eastern Cape',  'Port Elizabeth'],
    ['7441', 'Western Cape',  'Milnerton'],
    ['8001', 'Western Cape',  'Cape Town CBD'],
    ['8301', 'Northern Cape', 'Kimberley'],
    ['9301', 'Free State',    'Bloemfontein'],
    ['9460', 'Free State',    'Welkom'],
  ];

  it.each(cases)('maps %s → %s (%s)', (code, expected) => {
    expect(inferProvinceFromPostalCode(code)).toBe(expected);
  });

  it('returns empty string for out-of-range and non-numeric input', () => {
    expect(inferProvinceFromPostalCode('')).toBe('');
    expect(inferProvinceFromPostalCode('abcd')).toBe('');
    expect(inferProvinceFromPostalCode('99999')).toBe('');
  });
});

describe('normaliseAddressFields', () => {
  it('passes through cleanly when city and postalCode are already set', () => {
    const result = normaliseAddressFields({
      addressLine1: '57 Parfitt Avenue',
      addressLine2: 'Park West',
      city:         'Bloemfontein',
      province:     'Free State',
      postalCode:   '9301',
    });
    expect(result).toEqual({
      addressLine1: '57 Parfitt Avenue',
      addressLine2: 'Park West',
      city:         'Bloemfontein',
      province:     'Free State',
      postalCode:   '9301',
    });
  });

  it('infers province when city+postalCode are set but province is empty', () => {
    const result = normaliseAddressFields({
      addressLine1: '12 Rivonia Road',
      addressLine2: 'Sandton',
      city:         'Sandton',
      province:     '',
      postalCode:   '2196',
    });
    expect(result.province).toBe('Gauteng');
  });

  it('splits "Park West Bloemfontein 9301" dumped into addressLine2', () => {
    // This is the exact regression the QA run surfaced.
    const result = normaliseAddressFields({
      addressLine1: '57 Parfitt Avenue',
      addressLine2: 'Park West Bloemfontein 9301',
      city:         '',
      province:     '',
      postalCode:   '',
    });
    expect(result.postalCode).toBe('9301');
    expect(result.city).toBe('Bloemfontein');
    expect(result.province).toBe('Free State');
    // The suburb "Park West" should remain in addressLine2 after the rescue.
    expect(result.addressLine2).toBe('Park West');
  });

  it('splits a bare "Sandton 2196" line', () => {
    const result = normaliseAddressFields({
      addressLine1: '12 Rivonia Road',
      addressLine2: 'Sandton 2196',
      city:         '',
      province:     '',
      postalCode:   '',
    });
    expect(result.postalCode).toBe('2196');
    expect(result.city).toBe('Sandton');
    expect(result.province).toBe('Gauteng');
    expect(result.addressLine2).toBe('');
  });

  it('rescues from addressLine1 when addressLine2 is empty', () => {
    const result = normaliseAddressFields({
      addressLine1: '57 Parfitt Avenue, Bloemfontein 9301',
      addressLine2: '',
      city:         '',
      province:     '',
      postalCode:   '',
    });
    expect(result.postalCode).toBe('9301');
    expect(result.city).toBe('Bloemfontein');
    expect(result.province).toBe('Free State');
  });

  it('does not overwrite a pre-set city when rescuing postal code from line2', () => {
    const result = normaliseAddressFields({
      addressLine1: '57 Parfitt Avenue',
      addressLine2: 'Park West Bloemfontein 9301',
      city:         'Mangaung',       // user-entered or extracted from elsewhere
      province:     '',
      postalCode:   '',
    });
    expect(result.postalCode).toBe('9301');
    expect(result.city).toBe('Mangaung');
    expect(result.province).toBe('Free State');
  });

  it('leaves everything untouched when no postal code is present', () => {
    const result = normaliseAddressFields({
      addressLine1: '57 Parfitt Avenue',
      addressLine2: 'Park West',
      city:         '',
      province:     '',
      postalCode:   '',
    });
    expect(result.postalCode).toBe('');
    expect(result.province).toBe('');
    expect(result.addressLine2).toBe('Park West');
  });

  it('handles comma-separated dumps like "Park West, Bloemfontein, 9301"', () => {
    const result = normaliseAddressFields({
      addressLine1: '57 Parfitt Avenue',
      addressLine2: 'Park West, Bloemfontein, 9301',
      city:         '',
      province:     '',
      postalCode:   '',
    });
    expect(result.postalCode).toBe('9301');
    expect(result.city).toBe('Bloemfontein');
    expect(result.province).toBe('Free State');
  });

  it('trims stray whitespace in input fields', () => {
    const result = normaliseAddressFields({
      addressLine1: '  57 Parfitt Avenue  ',
      addressLine2: '  Park West  ',
      city:         '  Bloemfontein  ',
      province:     '  Free State  ',
      postalCode:   '  9301  ',
    });
    expect(result).toEqual({
      addressLine1: '57 Parfitt Avenue',
      addressLine2: 'Park West',
      city:         'Bloemfontein',
      province:     'Free State',
      postalCode:   '9301',
    });
  });
});
