import { describe, it, expect } from 'vitest';
import {
  composeBankTxQueryMessage,
  normalizeWhatsAppNumber,
} from '@/modules/accounting/services/capture/bankTxQueryMessage';

describe('composeBankTxQueryMessage', () => {
  const base = {
    companyName: 'Acme Trading',
    txDate: '2026-05-14',
    description: 'POS PURCHASE MAKRO SANDTON',
    amount: -1234.56,
  };

  it('includes company, date, description and absolute amount', () => {
    const { body } = composeBankTxQueryMessage(base);
    expect(body).toContain('Acme Trading');
    expect(body).toContain('14 May 2026');
    expect(body).toContain('POS PURCHASE MAKRO SANDTON');
    expect(body).toContain('R1 234,56');
    expect(body).toContain('photo of the slip');
  });

  it('appends the reference when present', () => {
    const { body } = composeBankTxQueryMessage({ ...base, reference: 'INV-0042' });
    expect(body).toContain('(ref INV-0042)');
  });

  it('truncates long descriptions to 120 chars', () => {
    const { body } = composeBankTxQueryMessage({ ...base, description: 'X'.repeat(300) });
    expect(body).toContain('X'.repeat(120));
    expect(body).not.toContain('X'.repeat(121));
  });

  it('falls back when the description is blank', () => {
    const { body } = composeBankTxQueryMessage({ ...base, description: '   ' });
    expect(body).toContain('no description');
  });
});

describe('normalizeWhatsAppNumber', () => {
  it('passes through bare E.164', () => {
    expect(normalizeWhatsAppNumber('+27821234567')).toBe('+27821234567');
  });
  it('strips the whatsapp: prefix', () => {
    expect(normalizeWhatsAppNumber('whatsapp:+27821234567')).toBe('+27821234567');
  });
  it('strips spaces, dashes, dots and parens', () => {
    expect(normalizeWhatsAppNumber('+27 (82) 123-45.67')).toBe('+27821234567');
  });
  it('converts SA local 0-leading numbers to +27', () => {
    expect(normalizeWhatsAppNumber('0821234567')).toBe('+27821234567');
  });
  it('rejects garbage, short and unprefixed-international inputs', () => {
    expect(normalizeWhatsAppNumber('hello')).toBeNull();
    expect(normalizeWhatsAppNumber('+2782')).toBeNull();
    expect(normalizeWhatsAppNumber('27821234567')).toBeNull();
    expect(normalizeWhatsAppNumber('')).toBeNull();
  });
});
