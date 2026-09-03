/**
 * A completeness claim that cannot fail is worse than none.
 *
 * `buildEnvelope` checks `rowsTotal + excludedCount === universeTotal`. Two
 * reports on master computed `universeTotal` FROM those same two numbers, so
 * the check could not fail whatever the report did:
 *
 *   · vat201ReportService — `allRows.length + basis.excluded.length`, where
 *     `allRows` is rowsTotal and `basis.excluded` becomes excludedRows. Both
 *     buckets come from ONE query that filters, so a leg the WHERE drops
 *     appears in neither and the identity still passes. On a statutory VAT
 *     return.
 *   · documents.ts — `universeTotal: page.rowsTotal` with no exclusions at all.
 *
 * CONTRACTS.md §1 already names this shape for `excludedTotal` — "a report
 * computing excludedTotal := universeTotal - rowsTotal will pass
 * unconditionally, having proved nothing". This is the same thing with the
 * sides swapped.
 *
 * The contract's own remedy is to OMIT the claim rather than synthesize it.
 * These assert the absence, because absence is the honest state until an
 * independent count exists.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
function src(p: string): string {
  return readFileSync(join(root, p), 'utf8');
}

describe('no report may synthesize its own universe', () => {
  it('vat201ReportService does not derive universeTotal from rowsTotal + excluded', () => {
    const t = src('src/modules/accounting/services/reports/vat201ReportService.ts');
    // The exact expression that made the identity unfalsifiable.
    expect(t).not.toMatch(/universeTotal:\s*allRows\.length\s*\+\s*basis\.excluded\.length/);
    // And no universeTotal built from the two checked quantities by any spelling.
    expect(t).not.toMatch(/universeTotal:\s*\w+\.length\s*\+\s*[\w.]+\.length/);
  });

  it('the vat_status tool passes no universeTotal it cannot substantiate', () => {
    expect(src('src/lib/mcp/tools/vat.ts')).not.toMatch(/universeTotal:\s*report\.universeTotal/);
  });

  it('list_documents does not claim a universe equal to its own row count', () => {
    expect(src('src/lib/mcp/tools/documents.ts')).not.toMatch(/universeTotal:\s*page\.rowsTotal/);
  });

  // The independently-derived ones must survive: this fix is about removing
  // claims that cannot fail, NOT about removing completeness reporting.
  it('leaves genuinely independent universe counts in place', () => {
    expect(src('src/modules/accounting/services/core/documentQueryService.ts'))
      .toMatch(/universeTotal:\s*Number\(universe\?\.cnt/);
    expect(src('src/modules/accounting/services/ar/unappliedReceiptService.ts'))
      .toMatch(/universeTotal:\s*Number\(totals\.universe_total/);
  });
});
