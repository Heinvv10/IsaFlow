import { describe, expect, it } from 'vitest';
import { parseAbsaPopText } from '@/modules/accounting/services/capture/pop/absaPopParser';

// Synthetic notices in ABSA's two layouts as pdf-parse renders them. Names, accounts and
// transaction numbers are invented.
const LAYOUT_BUSINESS = `Notice of Payment 13 November 2026
Absa Bank Limited Reg No 1986/004794/06 Authorised Financial Services
Dear EXAMPLE TRADING PTY LTD
Subject: Notice Of Payment: JANE Q PUBLIC
Please be advised that you made a payment to JANE Q PUBLIC as indicated below.
Transaction number: 80AB12CD34-11
Payment date: 2026-11-13
Payment made from: EXAMPLE MAIN
Payment made to: JANE Q PUBLIC
Beneficiary bank name: CAPITEC
Beneficiary account number: 1234567890
Bank branch code: 470010
For the amount of: 3 000.00
Immediate payment: N
Reference on beneficiary statement: Example Ref
Yours sincerely`;

const LAYOUT_ONLINE = `Absa Online: Notice of payment 13 November 2026
© Copyright. Absa Bank Limited, Registration Number 1986/004794/06. All rights reserved
Dear EXAMPLE TRADING PTY LTD
Subject: Notice of payment: John Doe
Transaction number: 80CD56EF78-13
Payment date: 20261113
Payment made from: EXAMPLE MAIN
Payment made to: John Doe
Beneficiary's bank name: CAPITEC
Beneficiary's account number: 9876543210
Bank branch code: 470010
For the amount of: 12,750.50
Immediate interbank payment : N
Reference on beneficiary statement: Example Ref
Additional comments by payer: -`;

describe('parseAbsaPopText', () => {
  it('reads the business-banking layout', () => {
    expect(parseAbsaPopText(LAYOUT_BUSINESS)).toEqual({
      ok: true,
      pop: {
        payerProfile: 'EXAMPLE TRADING PTY LTD',
        transactionNumber: '80AB12CD34-11',
        paymentDate: '2026-11-13',
        payerAccountName: 'EXAMPLE MAIN',
        beneficiary: 'JANE Q PUBLIC',
        beneficiaryBank: 'CAPITEC',
        amountCents: 300000,
        reference: 'Example Ref',
      },
    });
  });

  it('reads the Absa Online layout (compact date, comma thousands)', () => {
    const r = parseAbsaPopText(LAYOUT_ONLINE);
    expect(r.ok && r.pop).toMatchObject({
      transactionNumber: '80CD56EF78-13', paymentDate: '2026-11-13',
      beneficiary: 'John Doe', beneficiaryBank: 'CAPITEC', amountCents: 1275050,
    });
  });

  it('refuses text that is not an ABSA notice of payment', () => {
    expect(parseAbsaPopText(LAYOUT_BUSINESS.replace(/Absa/gi, 'Other'))).toEqual({ ok: false, reason: 'not_absa_notice' });
    expect(parseAbsaPopText(LAYOUT_BUSINESS.replace(/Notice of payment/gi, 'Statement'))).toEqual({ ok: false, reason: 'not_absa_notice' });
  });

  it.each([
    ['Transaction number', 'transaction_number'],
    ['Payment date', 'payment_date'],
    ['Payment made to', 'beneficiary'],
    ['For the amount of', 'amount'],
  ])('refuses a notice missing %s', (label, reason) => {
    const text = LAYOUT_BUSINESS.split('\n').filter((l) => !l.startsWith(label)).join('\n');
    expect(parseAbsaPopText(text)).toEqual({ ok: false, reason: `missing_${reason}` });
  });

  it.each(['2026-02-30', '20261332', '13/11/2026'])('refuses an impossible or unknown date %s', (d) => {
    expect(parseAbsaPopText(LAYOUT_BUSINESS.replace('2026-11-13', d))).toEqual({ ok: false, reason: 'missing_payment_date' });
  });

  it.each(['3 000', '3.000,00', '-3 000.00', '0.00', 'R3 000.00', '3 00.00', '99999999999999999999.00'])('refuses an amount it cannot read exactly: %s', (a) => {
    expect(parseAbsaPopText(LAYOUT_BUSINESS.replace('3 000.00', a))).toEqual({ ok: false, reason: 'missing_amount' });
  });

  it('refuses two different values for one field (an ambiguous notice)', () => {
    const text = `${LAYOUT_BUSINESS}\nTransaction number: 80FFFFFFFF-99`;
    expect(parseAbsaPopText(text)).toEqual({ ok: false, reason: 'missing_transaction_number' });
  });

  it('refuses a notice with no payer profile, or two different ones', () => {
    expect(parseAbsaPopText(LAYOUT_BUSINESS.replace(/^Dear .*$/m, ''))).toEqual({ ok: false, reason: 'missing_payer_profile' });
    expect(parseAbsaPopText(`${LAYOUT_BUSINESS}\nDear SOMEONE ELSE`)).toEqual({ ok: false, reason: 'missing_payer_profile' });
  });

  it.each([
    ['a beneficiary over 200 characters', (t: string) => t.replace('Payment made to: JANE Q PUBLIC', `Payment made to: ${'J'.repeat(201)}`)],
    ['a reference with a NUL byte', (t: string) => t.replace('Reference on beneficiary statement: Example Ref', 'Reference on beneficiary statement: Ex\u0000ample')],
    ['a payer profile over 200 characters', (t: string) => t.replace('Dear EXAMPLE TRADING PTY LTD', `Dear ${'E'.repeat(201)}`)],
    ['an amount beyond NUMERIC(14,2)', (t: string) => t.replace('3 000.00', '1 000 000 000 000.00')],
  ])('refuses (for a person to review) %s, which the table cannot store', (_name, edit) => {
    expect(parseAbsaPopText(edit(LAYOUT_BUSINESS))).toEqual({ ok: false, reason: 'unstorable_field' });
  });

  it('accepts the largest amount the table stores', () => {
    const r = parseAbsaPopText(LAYOUT_BUSINESS.replace('3 000.00', '999 999 999 999.99'));
    expect(r.ok && r.pop.amountCents).toBe(99_999_999_999_999);
  });

  it('returns null optional fields when they are absent', () => {
    const text = LAYOUT_BUSINESS.split('\n').filter((l) => !/^(Beneficiary bank name|Reference on)/.test(l)).join('\n');
    const r = parseAbsaPopText(text);
    expect(r.ok && r.pop.beneficiaryBank).toBeNull();
    expect(r.ok && r.pop.reference).toBeNull();
  });
});
