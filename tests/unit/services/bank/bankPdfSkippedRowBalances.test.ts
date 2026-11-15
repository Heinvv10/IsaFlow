/**
 * WP1 PR-A review round 3: a PDF text parser that passes over a line it cannot read leaves the survivors still
 * chaining, so a dropped LAST row stored a wrong closing as running_balance. A PDF now earns running_balance only when
 * every line the parser saw that looks like a transaction row (by that parser's own row shape: a date where its rows
 * put one, plus an amount) was read — otherwise balancesUnverifiable → 'unverified'. The ABSA date-amount FALLBACK
 * (another bank's or an unknown layout) is never trusted.
 *
 * Synthetic statements only (tests/unit/helpers/syntheticPdf.ts), end to end through parseStatement.
 */
import { describe, expect, it } from 'vitest';
import { parseStatement } from '@/modules/accounting/services/bank/bankStatementParseService';
import { syntheticPdf } from '../../helpers/syntheticPdf';

const pdf = (lines: string[]) => syntheticPdf([lines]).toString('base64');
const balancesOf = async (lines: string[]) => (await parseStatement({ fileType: 'pdf', pdfBase64: pdf(lines) })).statementBalances;
const UNVERIFIED = { source: 'unverified', openingCents: null, closingCents: null };

// ABSA slash-date layout: opening R1 000.00, −100.00, +250.00, −50.00 → R1 100.00.
const ABSA = ['ABSA BANK LIMITED', 'Cheque Account Statement',
  '01/09/2026 Bal Brought Forward 1 000.00',
  '02/09/2026 Debit Order Insurer 100.00 900.00',
  '03/09/2026 Deposit Client 250.00 1 150.00'];
const ABSA_LAST = '04/09/2026 Card Purchase Shop 50.00 1 100.00';

// Standard Bank column layout: page desc fee debit credit YYYYMMDD balance.
const SB = ['THE STANDARD BANK OF SOUTH AFRICA LIMITED', 'Statement',
  '1 BALANCE BROUGHT FORWARD 0.00 0.00 0.00 20260901 1,000.00',
  '1 PAYMENT TO SUPPLIER 0.00 -100.00 0.00 20260902 900.00',
  '1 CREDIT TRANSFER 0.00 0.00 250.00 20260903 1,150.00'];
const SB_LAST = '1 PAYMENT TO SHOP 0.00 -50.00 0.00 20260904 1,100.00';

describe('PDF: a row the parser could not read makes the statement unverified', () => {
  it('ABSA: the honest statement has figures; a garbled LAST row (survivors still chain) is unverified', async () => {
    expect(await balancesOf([...ABSA, ABSA_LAST])).toMatchObject({ source: 'running_balance', openingCents: 100000, closingCents: 110000 });
    // Before: the three survivors chained and stored closing R1 150.00 as running_balance.
    expect(await balancesOf([...ABSA, `${ABSA_LAST} X`])).toMatchObject(UNVERIFIED);
  });

  it('ABSA: a dated line that repeats the running balance (no movement) is not a dropped row', async () => {
    expect(await balancesOf([...ABSA, '03/09/2026 Notification Fee 5.00 T 1 150.00', ABSA_LAST]))
      .toMatchObject({ source: 'running_balance', closingCents: 110000 });
  });

  it('Standard Bank column layout: the honest statement has figures; a garbled LAST row is unverified', async () => {
    expect(await balancesOf([...SB, SB_LAST])).toMatchObject({ source: 'running_balance', openingCents: 100000, closingCents: 110000 });
    expect(await balancesOf([...SB, SB_LAST.replace('20260904', '2026094')])).toMatchObject(UNVERIFIED);
  });

  it('the ABSA date-amount fallback on an unrecognised layout is never trusted', async () => {
    const other = ['SOME OTHER BANK', '02/09/2026 Debit Order 100.00 900.00', '03/09/2026 Deposit 250.00 1 150.00',
      '04/09/2026 Card Purchase 50.00 1 100.00'];
    const parsed = await parseStatement({ fileType: 'pdf', pdfBase64: pdf(other) });
    expect(parsed.parser).toBe('fallback');
    expect(parsed.statementBalances).toMatchObject(UNVERIFIED);
  });
});
