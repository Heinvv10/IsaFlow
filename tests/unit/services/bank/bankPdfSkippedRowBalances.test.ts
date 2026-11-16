/**
 * WP1 PR-A review round 4 (decision, orchestrator 2026-11-15): a text-parsed PDF never gets 'running_balance'. No
 * PDF parser reads a printed closing or carried-forward figure, so a dropped row (a garbled one, or one split over
 * two lines — the round-4 breaker repro) leaves the survivors chaining to a wrong closing that nothing can check.
 * A PDF whose chain holds is stored as 'pdf_read' ("taken from the PDF's running-balance column; not checked against
 * a printed closing"), so a wrong figure shows up as a Difference instead of passing as checked. Every doubt rule
 * still gives 'unverified', and the ABSA date-amount FALLBACK (another bank's or an unknown layout) is never trusted.
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

describe('PDF: a chain that holds is pdf_read, never running_balance', () => {
  it('ABSA honest statement: pdf_read with the chain\'s figures', async () => {
    expect(await balancesOf([...ABSA, ABSA_LAST])).toEqual({ source: 'pdf_read', openingCents: 100000, closingCents: 110000, asAt: '2026-09-04' });
  });

  it('Standard Bank column layout honest statement: pdf_read', async () => {
    expect(await balancesOf([...SB, SB_LAST])).toMatchObject({ source: 'pdf_read', openingCents: 100000, closingCents: 110000 });
  });

  it('the breaker\'s repro: the LAST row split over two lines is dropped, and the wrong closing is labelled pdf_read', async () => {
    // Date and description on one line, the amounts on the next: the parser reads three rows, which chain to
    // R1 150.00. That figure is wrong (true R1 100.00) and cannot be checked; it is stored as pdf_read — shown with
    // that label and compared in the Difference — and never as running_balance.
    const split = [...ABSA, '04/09/2026 Card Purchase Shop', '50.00 1 100.00'];
    expect(await balancesOf(split)).toEqual({ source: 'pdf_read', openingCents: 100000, closingCents: 115000, asAt: '2026-09-03' });
    const sbSplit = [...SB, '1 PAYMENT TO SHOP', '0.00 -50.00 0.00 20260904 1,100.00'];
    expect(await balancesOf(sbSplit)).toMatchObject({ source: 'pdf_read', closingCents: 115000 });
  });

  it('the doubt rules still apply to a PDF: a brought-forward figure the chain disagrees with is unverified', async () => {
    const wrongOpening = ['ABSA BANK LIMITED', '01/09/2026 Bal Brought Forward 1 000.00',
      '02/09/2026 Debit Order Insurer 100.00 905.00', '03/09/2026 Deposit Client 245.00 1 150.00'];
    // ABSA derives each amount from the balances: the first row's derived −95.00 is not the −100.00 it printed.
    expect(await balancesOf(wrongOpening)).toMatchObject(UNVERIFIED);
  });

  it('the ABSA date-amount fallback on an unrecognised layout is never trusted', async () => {
    const other = ['SOME OTHER BANK', '02/09/2026 Debit Order 100.00 900.00', '03/09/2026 Deposit 250.00 1 150.00',
      '04/09/2026 Card Purchase 50.00 1 100.00'];
    const parsed = await parseStatement({ fileType: 'pdf', pdfBase64: pdf(other) });
    expect(parsed.parser).toBe('fallback');
    expect(parsed.statementBalances).toMatchObject(UNVERIFIED);
  });

  it('a CSV with the same chain is still running_balance (the PDF rule is the PDF\'s alone)', async () => {
    const csv = ['Date,Description,Amount,Balance', '2026-09-02,A,-100.00,900.00', '2026-09-03,B,250.00,1150.00'].join('\n');
    expect((await parseStatement({ fileType: 'csv', csvContent: csv, bankFormat: 'generic' })).statementBalances)
      .toMatchObject({ source: 'running_balance', openingCents: 100000, closingCents: 115000 });
  });
});
