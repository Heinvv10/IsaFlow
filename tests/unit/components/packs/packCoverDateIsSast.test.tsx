/**
 * THE COVER AND THE BASIS PAGE NAME ONE DAY.
 *
 * The covers took `generatedAt.slice(0, 10)` — the UTC date — while page 12
 * prints `formatPackTimestamp`, which converts to SAST. Between 22:00 and
 * 24:00 UTC the cover said 7 September and the basis page said 8 September at
 * 00:30. `packDateOf` is the one rule both must go through.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PackCoverV2 } from '@/components/accounting/packs/primitives/PackCoverV2';
import { buildFrontPages } from '@/modules/accounting/services/packs/pages/packFrontMatter';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { formatPackTimestamp } from '@/modules/accounting/services/packs/pages/packPeriodLabel';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackBasis } from '@/modules/accounting/services/packs/pages/packBasis';

// 22:30 UTC on 7 September is 00:30 on 8 September in Johannesburg.
const LATE_EVENING_UTC = '2026-09-07T22:30:00.000Z';

describe('cover date is the SAST day', () => {
  it('PackCoverV2 prints the SAST day, matching the basis page timestamp', () => {
    expect(formatPackTimestamp(LATE_EVENING_UTC)).toContain('8 September 2026');
    const html = renderToStaticMarkup(
      <PackCoverV2 document={{
        packType: 'board', packLabel: 'Board Pack', companyName: 'Demo', period: '2026',
        generatedAt: LATE_EVENING_UTC, draft: false,
        brand: { primaryColour: '#1a3a5c', secondaryColour: '#c8a86b', logoUrl: null, footerText: null, primaryInk: '#ffffff' },
        numberConvention: { scale: "R'000", currency: 'ZAR' },
        basisOfPreparation: { standard: 'IFRS for SMEs', sourceSystem: 'GL', extractedAt: LATE_EVENING_UTC, ledgerVersion: 'v1' },
        provenance: new PackFigureProvenance(), pages: [],
      }} />,
    );
    expect(html).toContain('Generated 8 September 2026');
    expect(html).not.toContain('7 September 2026');
  });

  it('the front-matter cover note prints the SAST day', () => {
    const basis: PackBasis = {
      basisOfPreparation: { standard: 'IFRS for SMEs', sourceSystem: 'GL', extractedAt: 'x', ledgerVersion: 'y' },
      numberConvention: { scale: PACK_SCALE, currency: 'ZAR' },
      definitions: [], caveats: [],
    };
    const [cover] = buildFrontPages({
      companyLegalName: 'Fixture (Pty) Ltd', period: '1 January 2026 to 7 September 2026', preparedBy: 'A Person',
      generatedAt: LATE_EVENING_UTC, draftReasons: [], scale: PACK_SCALE, currency: 'ZAR', basis, basisPageNumber: 12,
    });
    const text = JSON.stringify(cover);
    expect(text).toContain('Prepared by A Person on 8 September 2026');
    expect(text).not.toContain('on 7 September 2026');
  });
});
