// src/modules/accounting/services/afs/afsHtmlRendererService.ts

import type { AfsDocument, AfsSection, BrandProfile } from './afsTypes';
import { renderCoverHtml } from './afsHtmlCoverTemplates';
import { renderSectionContent, escapeHtml } from './afsHtmlTableRenderer';

// ── Public types ──────────────────────────────────────────────────────────────

export interface RenderOptions {
  watermark?: 'DRAFT — NOT FOR DISTRIBUTION';
  /** Injected in tests — reserved for future font embedding */
  fontsBase64Map?: Record<string, string>;
}

export interface AfsRenderContext {
  document: AfsDocument;
  sections: AfsSection[];
  brandProfile: BrandProfile;
  companyName: string;
  registrationNumber: string;
  coverPhotoUrl?: string;
  /** Entity type for terminology — defaults to 'pty' */
  entityType?: 'pty' | 'cc' | 'trust';
}

// ── Font pairs ────────────────────────────────────────────────────────────────

const FONT_PAIRS: Record<BrandProfile['fontFamily'], { heading: string; body: string }> = {
  professional: { heading: 'Playfair Display', body: 'Source Serif Pro' },
  modern:       { heading: 'Inter',             body: 'Inter' },
  executive:    { heading: 'Cormorant Garamond', body: 'Lato' },
  bold:         { heading: 'Montserrat',         body: 'Open Sans' },
};

// ── CSS builder ───────────────────────────────────────────────────────────────

function buildCss(bp: BrandProfile): string {
  const fonts = FONT_PAIRS[bp.fontFamily] ?? FONT_PAIRS.professional;

  return `
    /* Brand colours — injected as CSS custom properties */
    :root {
      --primary-colour: ${bp.primaryColour};
      --secondary-colour: ${bp.secondaryColour};
      --primary-tint: ${bp.primaryColour}1a; /* 10% opacity */
    }

    /* Font families — TODO: embed base64 fonts via fontsBase64Map */
    body {
      font-family: '${fonts.body}', Georgia, serif;
      font-size: 10pt;
      line-height: 1.5;
      color: #1a1a1a;
      margin: 0;
      padding: 0;
    }
    h1, h2, h3, h4 {
      font-family: '${fonts.heading}', Times New Roman, serif;
      margin-top: 1.4em;
      margin-bottom: 0.4em;
    }

    /* Print rules */
    @page {
      size: A4 portrait;
      margin: 20mm 20mm 20mm 25mm;
      @bottom-right { content: counter(page); }
      @bottom-left  { content: string(company-name); }
    }
    @page:first { margin: 0; }
    tr    { break-inside: avoid; }
    thead { display: table-header-group; }
    .note-heading { break-after: avoid; }
    p     { widows: 2; orphans: 2; }
    .section-start { break-before: right; }
    @page landscape { size: A4 landscape; }
    .wide-table { page: landscape; }

    /* Watermark */
    .watermark {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) rotate(-35deg);
      font-size: 48px;
      color: rgba(180, 0, 0, 0.18);
      white-space: nowrap;
      pointer-events: none;
      z-index: 9999;
    }

    /* Financial table */
    .financial-table { width: 100%; border-collapse: collapse; }
    .financial-table th { background: var(--primary-colour); color: #ffffff; font-weight: bold; text-align: left; padding: 8px; border-bottom: 2px solid var(--primary-colour); }
    .financial-table td { padding: 6px 8px; border-bottom: 1px solid #e0e0e0; }
    .financial-table tr:nth-child(even) td { background: #f7f7f7; }
    .financial-table .row-subtotal td { font-weight: bold; background: var(--primary-tint); }
    .financial-table .row-total td { background: var(--primary-colour); color: #ffffff; font-weight: bold; }
    .financial-table td:not(:first-child) { text-align: right; font-family: monospace; }

    /* Cover page base */
    .cover-page {
      width: 100%;
      min-height: 297mm;
      position: relative;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
      page-break-after: always;
      background-size: cover;
      background-position: center;
    }
    .cover-overlay {
      position: absolute;
      inset: 0;
      background: rgba(0,0,0,0.55);
    }
    .cover-classic .cover-title,
    .cover-classic .cover-period,
    .cover-classic .cover-company,
    .cover-classic .cover-reg {
      position: relative;
      color: #ffffff;
      z-index: 1;
    }
    .cover-classic .cover-logo { position: relative; z-index: 1; margin-bottom: 2rem; }
    .cover-logo img { max-height: 80px; max-width: 240px; object-fit: contain; }

    /* Modern split cover */
    .cover-modern { flex-direction: row; align-items: stretch; }
    .cover-panel { flex: 0 0 50%; display: flex; flex-direction: column; justify-content: center; align-items: flex-start; padding: 48px; color: #ffffff; }
    .cover-panel .cover-title,
    .cover-panel .cover-period,
    .cover-panel .cover-company,
    .cover-panel .cover-reg { color: #ffffff; text-align: left; }
    .cover-photo { flex: 1; background-size: cover; background-position: center; }

    /* Bold cover */
    .cover-bold { position: relative; overflow: hidden; }
    .cover-geo { position: absolute; inset: 0; }
    .cover-bold .cover-logo,
    .cover-bold .cover-title,
    .cover-bold .cover-period,
    .cover-bold .cover-company,
    .cover-bold .cover-reg { position: relative; z-index: 1; }

    /* Minimal cover */
    .cover-minimal { background: #ffffff; }
    .cover-rule { width: 60%; border: none; border-top: 2px solid; margin: 1.5rem auto; }
    .cover-minimal .cover-title { font-size: 2rem; }

    /* Section layout */
    section { margin-top: 2rem; }
  `;
}

// ── Period helper ─────────────────────────────────────────────────────────────

function resolvePeriodEnd(doc: AfsDocument): string {
  if (doc.period) return doc.period;
  if (doc.fiscalYear) return `28 February ${doc.fiscalYear}`;
  return 'year end';
}

// ── Watermark ─────────────────────────────────────────────────────────────────

function buildWatermark(text: string): string {
  return `<div class="watermark">${text}</div>`;
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export function renderAfsToHtml(
  context: AfsRenderContext,
  options?: RenderOptions,
): string {
  const { document, sections, brandProfile, companyName, registrationNumber, coverPhotoUrl, entityType } = context;

  // Entity-aware document title
  const statementsTitle = entityType === 'trust'
    ? 'Financial Statements'
    : 'Annual Financial Statements';

  const css = buildCss(brandProfile);
  const periodEnd = resolvePeriodEnd(document);

  const coverHtml = renderCoverHtml(brandProfile.coverStyle, {
    primaryColour: brandProfile.primaryColour,
    secondaryColour: brandProfile.secondaryColour,
    logoUrl: brandProfile.logoUrl,
    companyName,
    registrationNumber,
    periodEnd,
    coverPhotoUrl,
  });

  const sectionsHtml = sections.map(renderSectionContent).join('\n');

  const watermarkHtml = options?.watermark
    ? buildWatermark(options.watermark)
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${escapeHtml(statementsTitle)} — ${escapeHtml(companyName)}</title>
  <style>
${css}
  </style>
</head>
<body>
${watermarkHtml}
${coverHtml}
<main>
${sectionsHtml}
</main>
</body>
</html>`;
}
