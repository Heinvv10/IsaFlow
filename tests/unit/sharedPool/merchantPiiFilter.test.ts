import { describe, expect, it } from 'vitest';
import {
  BUSINESS_WORDS, filterMerchant, GENERIC_TOKENS, MAX_WORDS, NOISE_TOKENS, poolMerchantKey, type MerchantRejectReason,
} from '@/modules/accounting/services/sharedPool/merchantPiiFilter';

describe('filterMerchant — merchants it keeps (and the key it keeps)', () => {
  it.each([
    ['ESKOM PREPAID 0412345678901', 'ESKOM'],
    ['POS PURCHASE ENGEN SANDTON 1234 ZA', 'ENGEN'],
    ['VODACOM 0821234567', 'VODACOM'],
    ['MTN AIRTIME', 'MTN'],
    ['Shell Ultra City N1', 'SHELL'],
    ['TELKOM DEBIT ORDER 21/10/2026', 'TELKOM'],
    ['CHECKERS HYPER CENTURION', 'CHECKERS'],
    ['Woolworths Food Rosebank', 'WOOLWORTHS'],
    ['TAKEALOT.COM', 'TAKEALOT'],
    ['SARS EFILING PAYE 7012345678', 'SARS'],
    ['MR PRICE HOME MENLYN', 'MRPRICE'],
    ['MR D FOOD ORDER', 'MRD'],
    ["PICK N PAY FAMILY FOODS", 'PICKNPAY'],
    ["Pick'n'Pay Hypermarket", 'PICKNPAY'],
    ['CELL C RECHARGE', 'CELLC'],
    ['E-TOLL SANRAL', 'ETOLL'],
    ['UBER *TRIP 2026-10-20', 'UBER'],
    ['GOOGLE *WORKSPACE', 'GOOGLE'],
    ['FNB MONTHLY ACCOUNT FEE', 'FNB'],
    ['CARD XXXX1234 NANDOS MALL', 'NANDOS'],
    ['Café Nescafé Engen', 'ENGEN'],
    ['DSTV MULTICHOICE SUBSCRIPTION', 'DSTV'],
    ['MICROSOFT*365 BUSINESS', 'MICROSOFT'],
  ])('%s -> %s', (raw, key) => {
    expect(filterMerchant(raw)).toEqual({ ok: true, merchant: key });
  });

  it.each([
    ['JOES PLUMBING SERVICES', 'JOES PLUMBING'],
    ['ACME OFFICE SUPPLIES PTY LTD', 'ACME OFFICE'],
    ['Bobs Hardware 2026-10-01', 'BOBS HARDWARE'],
    ['CORNER CAFE 14:32', 'CORNER CAFE'],
    ['HILLTOP SECURITY', 'HILLTOP SECURITY'],
  ])('an unlisted business keys on its first words: %s -> %s', (raw, key) => {
    expect(filterMerchant(raw)).toEqual({ ok: true, merchant: key });
  });

  it.each([
    ['FNB APP PAYMENT ESKOM 12345678', 'ESKOM'],
    ['ABSA DEBIT ORDER SANTAM', 'SANTAM'],
    ['CAPITEC POS PURCHASE ENGEN SANDTON', 'ENGEN'],
    ['YOCO *CORNER CAFE', 'CORNER CAFE'],
    ['PAYFAST*TAKEALOT', 'TAKEALOT'],
    ['ABSA SERVICE FEE', 'ABSA'],
    ['NEDBANK MONTHLY ACCOUNT FEE 12345678', 'NEDBANK'],
    ['BUILDERS WAREHOUSE MIDRAND', 'BUILDERSWAREHOUSE'],
  ])('a bank or payment processor is the channel, not the merchant: %s -> %s', (raw, key) => {
    expect(filterMerchant(raw)).toEqual({ ok: true, merchant: key });
  });

  it.each([
    ['PAYFAST*N MOKOENA', 'person_name'],
    ['FNB APP PAYMENT 12345678 MOKOENA', 'identifier'],
    ['YOCO 0821234567 KASI KITCHEN', 'identifier'],
  ])('a channel licenses nothing the merchant behind it would not: %s -> %s', (raw, reason) => {
    expect(filterMerchant(raw)).toEqual({ ok: false, reason });
  });

  it('BUILDERS alone is a trade word, not the Builders brand', () => {
    expect(filterMerchant('MOKOENA BUILDERS')).toEqual({ ok: true, merchant: 'MOKOENA BUILDERS' });
    expect(filterMerchant('BUILDERS 12345678')).toEqual({ ok: false, reason: 'identifier' });
  });

  it('the same merchant from different branches and dates gives one key', () => {
    const keys = ['ENGEN SANDTON 0412', 'ENGEN DURBAN NORTH', 'POS ENGEN 21OCT', 'Engen Midrand 12:01'].map(poolMerchantKey);
    expect(new Set(keys)).toEqual(new Set(['ENGEN']));
  });
});

describe('filterMerchant — what it rejects', () => {
  const cases: Array<[string, MerchantRejectReason]> = [
    // empty / too short
    ['', 'empty'],
    ['   ', 'empty'],
    ['1234567', 'identifier'],
    ['*** 12/10', 'empty'],
    ['AB', 'too_short'],
    // contact details
    ['payment from john.smith@gmail.com', 'contact_detail'],
    // salary, wages, loans, transfers, payments to people
    ['SALARY OCT 2026', 'person_payment'],
    ['SALARIES BATCH', 'person_payment'],
    ['WAGES WEEK 42', 'person_payment'],
    ['J SMITH SALARY', 'person_payment'],
    ['LOAN REPAYMENT', 'person_payment'],
    ['TRANSFER TO SAVINGS', 'person_payment'],
    ['IB TRF 62012345', 'person_payment'],
    ['FNB APP PAYMENT TO THABO', 'person_payment'],
    ['CASHSEND 0821234567', 'person_payment'],
    ['SEND MONEY', 'person_payment'],
    ['EWALLET PAYMENT', 'person_payment'],
    ['PAYSHAP TO 0831234567', 'person_payment'],
    ['DIRECTORS DRAWINGS', 'person_payment'],
    ['STAFF BONUS DEC', 'person_payment'],
    ['REIMBURSEMENT PETROL', 'person_payment'],
    ['MAINTENANCE PAYMENT', 'person_payment'],
    // identifiers with nothing merchant-like left: the whole line is rejected, not stripped
    ['PAYMENT 8001015009087', 'identifier'],
    ['EFT 62012345678', 'identifier'],
    ['REF 1234567890', 'identifier'],
    ['DEPOSIT 082 123 4567', 'identifier'],
    ['ACB CREDIT 4071234567', 'identifier'],
    ['NEW SUPPLIER 4071234567', 'identifier'],
    ['+27 82 123 4567', 'identifier'],
    ['800101 5009 087', 'identifier'],
    // person shapes
    ['J SMITH', 'person_name'],
    ['SMITH J', 'person_name'],
    ['J.P. NEL', 'person_name'],
    ['MR NDLOVU', 'person_name'],
    ['MRS VAN DER MERWE', 'person_name'],
    ['DR PATEL ROOMS', 'person_name'],
    ['ME BOTHA', 'person_name'],
    ['JOHN WILLIAMS', 'person_name'],
    ['THABO MOKOENA', 'person_name'],
    ['PIETER DU TOIT', 'person_name'],
    // free text
    ['for the kids party at the park on saturday afternoon', 'free_text'],
    ['PLEASE PAY THE ACCOUNT FOR THE MONTH OF OCTOBER', 'free_text'],
    // generic banking words only
    ['PAYMENT', 'generic'],
    ['CASH DEPOSIT', 'generic'],
    ['ATM WITHDRAWAL', 'generic'],
    ['MONTHLY SERVICE FEE', 'generic'],
    ['DEBIT ORDER', 'generic'],
    ['thanks for lunch', 'free_text'],
    ['BIRTHDAY GIFT MOM', 'free_text'],
    ['INTEREST', 'generic'],
    ['REVERSAL', 'generic'],
  ];
  it.each(cases)('%j -> %s', (raw, reason) => {
    expect(filterMerchant(raw)).toEqual({ ok: false, reason });
  });

  it('non-strings are rejected', () => {
    expect(filterMerchant(null)).toEqual({ ok: false, reason: 'empty' });
    expect(filterMerchant(undefined)).toEqual({ ok: false, reason: 'empty' });
    expect(filterMerchant(12345)).toEqual({ ok: false, reason: 'empty' });
  });

  it(`more than ${MAX_WORDS} words left is free text, even for invented business-like words`, () => {
    expect(filterMerchant('ALPHA MOTORS BRAVO CHARLIE DELTA ECHO FOXTROT')).toEqual({ ok: false, reason: 'free_text' });
    expect(filterMerchant('ALPHA MOTORS BRAVO CHARLIE DELTA ECHO')).toEqual({ ok: true, merchant: 'ALPHA MOTORS' });
  });

  it('a first name anywhere in the line is a person, not just in front', () => {
    for (const raw of ['GENERAL JOHN SMITH', 'SMITH JOHN', 'SUNDRY THABO M', 'MOKOENA SIPHO TRADING']) {
      expect(filterMerchant(raw)).toEqual({ ok: false, reason: 'person_name' });
    }
  });

  it('two plain words with no brand and no trade word are not kept (could be a full name)', () => {
    for (const raw of ['NONHLANHLA MOKOENA', 'VAN WYK', 'NOMALANGA DLAMINI', 'PURPLE RIDES', 'ZEBRA STRIPES']) {
      expect(filterMerchant(raw)).toEqual({ ok: false, reason: 'not_a_business' });
    }
  });

  it('the trade word must be in the key itself, not elsewhere in the line', () => {
    for (const raw of ['INTERNET PMT NONHLANHLA MOKOENA', 'IB PAYMENT SERVICES NONHLANHLA MOKOENA', 'MOKOENA DLAMINI PTY LTD',
      'NONHLANHLA MOKOENA PLUMBING', 'ONLINE BANKING DLAMINI MOKOENA']) {
      expect(filterMerchant(raw)).toEqual({ ok: false, reason: 'not_a_business' });
    }
  });

  it('trade words are never also noise or generic words (those never reach the key)', () => {
    expect([...BUSINESS_WORDS].filter((w) => NOISE_TOKENS.has(w) || GENERIC_TOKENS.has(w))).toEqual([]);
  });

  it('a person-payment word wins over a known brand (a salary to a VODACOM employee is still a salary)', () => {
    expect(filterMerchant('VODACOM SALARY J SMITH')).toEqual({ ok: false, reason: 'person_payment' });
  });

  it('an identifier never survives into a key', () => {
    for (const raw of ['ESKOM 0412345678901', 'VODACOM 0821234567', 'SARS 7012345678']) {
      const r = filterMerchant(raw);
      expect(r.ok && /\d/.test(r.merchant)).toBe(false);
    }
  });

  it('a brand next to a name keys on the brand alone, so the name is never stored', () => {
    expect(filterMerchant('UBER J SMITH')).toEqual({ ok: true, merchant: 'UBER' });
    expect(filterMerchant('MR NDLOVU CHECKERS')).toEqual({ ok: true, merchant: 'CHECKERS' });
  });

  it('no key contains a digit, punctuation or lower-case letter', () => {
    const inputs = ['Engen 24/7 Shop!', 'acme-tools (pty) ltd', "o'brien's bar", 'K&M MOTORS', 'ZOOM.US 888-799'];
    for (const raw of inputs) {
      const k = poolMerchantKey(raw);
      if (k !== null) expect(k).toMatch(/^[A-Z]+( [A-Z]+)*$/);
    }
  });
});
