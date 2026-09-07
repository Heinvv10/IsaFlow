/**
 * The 12-page pack's cover — page 1. Distinct from the legacy `PackCover`,
 * which renders the OLD `PackDocument` shape; this one reads
 * `PackPagesDocument` (packPageModel.ts) and carries the resolved brand
 * (logo, footer) the new pack pipeline produces.
 *
 * Page 1's title is exempt from `assertPageTitleIsAMessage` by page number —
 * it is the company's legal name, not a conclusion about the period, and
 * that is what this component prints as the headline.
 */
import type { ReactNode } from 'react';
import { PACK_LABELS } from '@/modules/accounting/services/packs/packSections';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';

export interface PackCoverV2Props {
  document: PackPagesDocument;
  /** Page 1's own blocks — spec §5.4 puts the confidentiality mark and the
   *  preparer on the cover, and those are model content, not layout this
   *  component may invent. */
  children?: ReactNode;
}

export function PackCoverV2({ document, children }: PackCoverV2Props) {
  // Date only, same reasoning as the legacy cover: the pack is a period
  // document, and a UTC generation timestamp on an SAST page invites a wrong
  // reading of the day.
  const generated = document.generatedAt.slice(0, 10);

  return (
    // `data-brand-name` is what the brand band prints. The band is a
    // pseudo-element (see `.pack-cover::after` for why it must stay one), so
    // the only way to put words in it is `content: attr(...)` — and a solid
    // navy rectangle with nothing in it, first thing on the first page, reads
    // as a placeholder somebody forgot to fill. It is the company's own name,
    // not a figure.
    <section data-pack-cover data-brand-name={document.companyName} className="pack-page pack-cover">
      {document.brand.logoUrl && (
        // A plain <img>, not next/image: this page is photographed by
        // Chromium (Playwright/Gotenberg), not served through Next's image
        // pipeline — same pattern as pdfExportService/afsHtmlCoverTemplates.
        <img src={document.brand.logoUrl} alt="" className="pack-cover-logo" />
      )}
      <p className="pack-cover-eyebrow">{document.basisOfPreparation.standard}</p>
      <h1 className="pack-cover-company">{document.companyName}</h1>
      <p className="pack-cover-label">{PACK_LABELS[document.packType]}</p>
      <p className="pack-cover-period">{document.period}</p>
      <p className="pack-cover-meta">Generated {generated}</p>
      {children}
    </section>
  );
}
