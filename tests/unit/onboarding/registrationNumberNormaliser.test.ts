/**
 * Tests for the CIPC registration number whitespace normaliser.
 *
 * Ensures extracted reg numbers like "2020 / 912495 / 07" end up canonical
 * ("2020/912495/07") while leaving non-slash formats and already-clean
 * values untouched.
 */

import { describe, it, expect } from 'vitest';
import { normaliseRegistrationNumber } from '@/modules/onboarding/services/registrationNumberNormaliser';

describe('normaliseRegistrationNumber', () => {
  it('collapses spaces around slashes in a standard SA reg number', () => {
    expect(normaliseRegistrationNumber('2020 / 912495 / 07')).toBe('2020/912495/07');
  });

  it('handles asymmetric spacing (spaces on only one side)', () => {
    expect(normaliseRegistrationNumber('2020/ 912495 /07')).toBe('2020/912495/07');
    expect(normaliseRegistrationNumber('2020 /912495/ 07')).toBe('2020/912495/07');
  });

  it('handles multiple spaces around a slash', () => {
    expect(normaliseRegistrationNumber('2020   /   912495   /   07')).toBe('2020/912495/07');
  });

  it('leaves an already-canonical number untouched', () => {
    expect(normaliseRegistrationNumber('2005/023519/07')).toBe('2005/023519/07');
  });

  it('trims leading/trailing whitespace even when there is no slash', () => {
    expect(normaliseRegistrationNumber('  CK 2004/123456/23  ')).toBe('CK 2004/123456/23');
  });

  it('returns non-slash formats (older CK, foreign IDs) unchanged after trim', () => {
    expect(normaliseRegistrationNumber('K2022123456')).toBe('K2022123456');
    expect(normaliseRegistrationNumber('  12345678  ')).toBe('12345678');
  });

  it('returns an empty string for blank input', () => {
    expect(normaliseRegistrationNumber('')).toBe('');
    expect(normaliseRegistrationNumber('   ')).toBe('');
  });

  it('handles the exact H10 Holdings value caught during QA', () => {
    expect(normaliseRegistrationNumber('2020 / 912495 / 07')).toBe('2020/912495/07');
  });

  it('does not touch slashes inside non-reg-number-looking strings', () => {
    // Only the spacing around slashes is touched; the content is otherwise
    // preserved. This is intentional — we trust the VLM for the characters.
    expect(normaliseRegistrationNumber('CC / 2024 / 001 / X')).toBe('CC/2024/001/X');
  });
});
