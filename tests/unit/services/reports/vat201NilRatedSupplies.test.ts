/**
 * getNilRatedSupplies' row mapping, with the one query's rows scripted (no database). `uncodedOnTaxedJournals` is
 * the uncoded row's `base_on_taxed` only: not its whole base, and not a coded row's.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));

import { getNilRatedSupplies } from '@/modules/accounting/services/reports/vat201NilRatedSupplies';

const row = (rawVatType: string | null, base: number, baseOnTaxed: number) => ({
  raw_vat_type: rawVatType, vat_type: rawVatType ?? 'zero_rated',
  base, base_on_taxed: baseOnTaxed, base_on_capital: 0, base_on_mixed: 0,
});
const read = () => getNilRatedSupplies('c1', '2026-07-01', '2026-07-31');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getNilRatedSupplies: the uncoded part of the give-back', () => {
  it('is the uncoded row\'s base on taxed journals, not its whole base and not the coded row\'s', async () => {
    m.sql.mockResolvedValue([row('zero_rated', 800, 300), row(null, 1000, 600)]);
    expect(await read()).toMatchObject({
      zeroRated: 1800, onTaxedJournals: 900, uncodedAssumedZeroRated: 1000, uncodedOnTaxedJournals: 600,
    });
  });

  it('can exceed the whole give-back when a coded credit note nets it down', async () => {
    m.sql.mockResolvedValue([row('exempt', -400, -400), row(null, 1000, 600)]);
    expect(await read()).toMatchObject({ exempt: -400, onTaxedJournals: 200, uncodedOnTaxedJournals: 600 });
  });

  it('is nil when every nil-rated line is coded', async () => {
    m.sql.mockResolvedValue([row('zero_rated', 800, 300), row('exempt', 50, 50)]);
    expect(await read()).toMatchObject({ onTaxedJournals: 350, uncodedOnTaxedJournals: 0, uncodedAssumedZeroRated: 0 });
  });
});
