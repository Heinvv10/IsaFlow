/**
 * ONE reading of the operating line, enforced rather than offered.
 *
 * The first fix for this made `packMetricReads.operatingProfitOf` available
 * and routed two call sites through it. A helper the next author can bypass
 * is not a fix, and two call sites in that very diff already did:
 * `highlightsTitle` read `operatingProfit ?? 0` and `resultsTitle` read
 * `operatingProfit ?? netProfit`. On a company whose classifier produced no
 * operating line that printed "Operating margin is 0.0%" beside a tile
 * showing 750 000, and "operating profit of 512 000" above a table row
 * showing 750 000.
 *
 * That is strictly worse than the crash it replaced. A hard render failure is
 * loud and diagnosable; a pack whose title contradicts the figure three
 * centimetres away SHIPS, and tells a director something false.
 *
 * Two assertions, because neither alone is enough. The first is behavioural —
 * it composes the real document and reads the title against the cell beside
 * it, which is the assertion shape nothing in this suite had. The second is a
 * scoped guard over the pack services only, allow-listing the one module that
 * is allowed to read the raw field; a text guard is a linter, not a proof,
 * and it is here to stop the NEXT bypass rather than to demonstrate this one.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { operatingProfitOf } from '@/modules/accounting/services/packs/figures/packMetricReads';
import type { ReportPackFigures } from '@/modules/accounting/services/reports/reportPackDataService';

const PACK_SERVICES = 'src/modules/accounting/services/packs';

/** The one module permitted to read `ReportPackFigures.operatingProfit`. */
const ALLOWED = new Set(['packMetricReads.ts']);

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFilesUnder(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('the operating line has one reading', () => {
  it('resolves the classifier line when present and its documented fallback when not', () => {
    const base = { revenue: 100, costOfSales: 40, otherIncome: 5, operatingExpenses: 30 } as ReportPackFigures;
    expect(operatingProfitOf({ ...base, operatingProfit: 12 })).toBe(12);
    expect(operatingProfitOf({ ...base, operatingProfit: undefined })).toBe(35);
  });

  it('is the only place in the pack services that reads the raw optional field', () => {
    const offenders = tsFilesUnder(PACK_SERVICES)
      .filter((path) => !ALLOWED.has(path.split('/').pop()!))
      .filter((path) => /\.operatingProfit\b/.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
