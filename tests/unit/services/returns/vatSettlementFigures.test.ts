/**
 * VR (coordinator ruling on review round 1, M3): the figures a VAT settlement may be posted from. getVat201Report is
 * mocked; on real PG: tests/integration/vat-returns-ledger-gap.int.test.ts.
 *   drift (version vs the VAT201 now) is refused and never overridable; a ledger gap (control accounts vs the VAT201)
 *   is refused unless an owner or admin acknowledges it with a reason.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/accounting/services/reports/vat201ReportService', () => ({ getVat201Report: vi.fn() }));

import { getVat201Report } from '@/modules/accounting/services/reports/vat201ReportService';
import { checkSettlementFigures } from '@/modules/accounting/services/returns/vatSettlementFigures';

const CO = '00000000-0000-0000-0000-000000000001';
const V = { versionNo: 1, outputTax: 10785, inputTax: 5400, netVat: 5385 };
const report = (outputTax: number, inputTax: number) => vi.mocked(getVat201Report).mockResolvedValue(
  { totals: { outputTax, inputTax, netVat: outputTax - inputTax } } as never);
const run = (ledgerNet: number, ack?: { reason: string; role: string }) =>
  checkSettlementFigures(CO, '2026-07-01', '2026-08-31', V, ledgerNet, ack).then((g) => g, (e: unknown) => e);
const OWNER = { reason: 'Invoice INV-9 was cancelled; its journal is still posted', role: 'owner' };

describe('checkSettlementFigures (VR)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('version, VAT201 and ledger agree: nothing to record', async () => {
    report(10785, 5400);
    expect(await run(5385)).toBeNull();
    expect(vi.mocked(getVat201Report)).toHaveBeenCalledWith(CO, '2026-07-01', '2026-08-31', { detail: 'summary' });
  });

  it('1c is rounding, not drift and not a gap', async () => {
    report(10785.01, 5400);
    expect(await run(5385.02)).toBeNull();
  });

  it.each([['output', 10800, 5400], ['input', 10785, 5385]])('the VAT201 now differs from the version (%s tax): 409 VAT_SETTLEMENT_DRIFT', async (_w, o, i) => {
    report(o, i);
    expect(await run(o - i)).toMatchObject({ status: 409, refusalCode: 'VAT_SETTLEMENT_DRIFT' });
  });

  it('output and input both moved by the same amount (net unchanged): still drift', async () => {
    report(10885, 5500);
    expect(await run(5385)).toMatchObject({ status: 409, refusalCode: 'VAT_SETTLEMENT_DRIFT' });
  });

  it('drift is not overridable: an owner acknowledging a gap is still refused', async () => {
    report(10800, 5400);
    expect(await run(5340, OWNER)).toMatchObject({ status: 409, refusalCode: 'VAT_SETTLEMENT_DRIFT',
      refusalDetails: { versionNetVat: 5385, reportNetVat: 5400 } });
  });

  it('a ledger gap without an acknowledgement: 409 VAT_SETTLEMENT_LEDGER_GAP naming both figures', async () => {
    report(10785, 5400);
    const e = await run(5340);
    expect(e).toMatchObject({ status: 409, refusalCode: 'VAT_SETTLEMENT_LEDGER_GAP',
      refusalDetails: { ledgerNetVat: 5340, reportNetVat: 5385 } });
    expect((e as Error).message).toContain('5340');
    expect((e as Error).message).toContain('5385');
  });

  it('an owner acknowledging the gap with a reason: the gap and the trimmed reason come back to be recorded', async () => {
    report(10785, 5400);
    expect(await run(5340, { ...OWNER, reason: `  ${OWNER.reason} ` }))
      .toEqual({ ledgerNetVat: 5340, reportNetVat: 5385, reason: OWNER.reason });
  });

  it('a manager may not acknowledge it: 403', async () => {
    report(10785, 5400);
    expect(await run(5340, { ...OWNER, role: 'manager' })).toMatchObject({ status: 403 });
  });

  it('a reason with nothing visible in it: 400', async () => {
    report(10785, 5400);
    expect(await run(5340, { ...OWNER, reason: ' ​ ' })).toMatchObject({ status: 400 });
  });
});
