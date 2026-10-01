// src/lib/pdf/printFurniture.ts
//
// The footer Chromium draws in the page margin, and the PDF's own metadata.
//
// The footer cannot be CSS: `@bottom-center` margin boxes and
// `position: running()` are not implemented in Blink, and would silently draw
// nothing. Chromium substitutes `.pageNumber` / `.totalPages` inside the
// template it is handed, which is the only mechanism that works on both
// transports.
//
// Everything interpolated here is escaped: a company name is user-controlled
// text and this string is parsed as HTML by the renderer.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PACK_FOOTER_FACE_FILE, PACK_FOOTER_FONT_FAMILY, packFooterFaceCss,
} from '@/lib/charts/packFont';
import { escapeHtml } from '@/modules/accounting/services/packs/escapeHtml';
import type { PdfMetadata } from './pdfTransport';

/**
 * The footer's face, inlined.
 *
 * `packFooterFaceCss` documents the whole mechanism — the short version is
 * that Chromium renders this template in a document that inherits nothing and
 * may fetch nothing, and the ONLY face it will paint with is a data URI the
 * main document has already loaded. `usePrintMode.ts` loads exactly this
 * string's resource before the page says it is print-ready.
 *
 * Read once, from `public/` — the same file the print page's own stylesheet
 * serves. A missing file is a broken deploy rather than a tenant condition,
 * and the alternative to throwing is the silent fallback this exists to
 * remove.
 */
let footerFace: string | null = null;

function footerStyleBlock(): string {
  footerFace ??= packFooterFaceCss(
    readFileSync(join(process.cwd(), 'public', 'fonts', PACK_FOOTER_FACE_FILE)).toString('base64'),
  );
  return `<style>${footerFace}</style>`;
}

/**
 * The confidentiality mark every pack footer carries, and the same words the
 * cover's own disclosure uses (`packFrontMatter.ts`). One constant, because a
 * cover that says one thing and a running footer that says another is a
 * document arguing with itself about who may read it.
 */
export const PACK_CONFIDENTIALITY = 'Confidential — for board use';

export interface PackFurniture {
  companyName: string;
  packLabel: string;
  period: string;
  confidentiality: string;
  draft: boolean;
}

export type { PdfMetadata };

export const FOOTER_PT = 7.5;
/** Gap between the title and the right block. */
export const FOOTER_GAP_MM = 6;
/** Wide enough for "NN / NN" at the footer's size, with tabular figures. */
export const FOOTER_PAGE_BOX_MM = 14;
/** The A4 sheet less the 18mm side margins the footer is padded by. */
export const FOOTER_CONTENT_MM = 210 - 2 * 18;

/** The two blocks' words, unescaped — what the width check measures. */
export function footerTitleText(f: PackFurniture): string {
  return [f.companyName, f.packLabel, f.period].join(' · ');
}
export function footerRightText(f: PackFurniture): string {
  return f.draft ? `${f.confidentiality} · DRAFT` : f.confidentiality;
}

export function buildFooterHtml(f: PackFurniture): string {
  const left = [f.companyName, f.packLabel, f.period].map(escapeHtml).join(' · ');
  const right = escapeHtml(footerRightText(f));
  // TWO COLUMNS. The title takes whatever the right block leaves and never
  // wraps across it (`min-width:0` lets it shrink, ellipsis is the last
  // resort). The right block is `flex:none`: the confidentiality line and a
  // page-number box of FIXED width and tabular figures, sized for "NN / NN",
  // so nothing moves between page 9 and page 10. An earlier `space-between`
  // moved the centre with the page number; `1fr auto 1fr` fixed that but
  // squeezed the title onto two lines and broke it mid-date.
  return (
    footerStyleBlock() +
    `<div style="font-family:'${PACK_FOOTER_FONT_FAMILY}';font-size:${FOOTER_PT}pt;color:#8a8a8a;width:100%;` +
    `padding:0 18mm;border-top:0.5pt solid #d8d8d8;display:flex;align-items:baseline;gap:${FOOTER_GAP_MM}mm">` +
    '<span style="flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
    `${left}</span>` +
    `<span style="flex:none;white-space:nowrap;display:flex;gap:${FOOTER_GAP_MM / 3}mm">` +
    `<span>${right}</span>` +
    `<span style="display:inline-block;width:${FOOTER_PAGE_BOX_MM}mm;text-align:right;font-variant-numeric:tabular-nums">` +
    '<span class="pageNumber"></span> / <span class="totalPages"></span></span></span>' +
    '</div>'
  );
}

/**
 * The prefix every non-standard Info key carries.
 *
 * Namespaced because the Info dictionary is a flat namespace shared with
 * whatever the renderer wrote: a bare `/Period` is one upstream change away
 * from meaning something else. `pdfinfo` prints these under `Custom
 * Metadata`, which is the line that still read `no` after Title, Subject,
 * Author and Creator all started arriving — the standard keys do not count
 * as custom however many of them are set.
 */
const CUSTOM_PREFIX = 'IsaFlow';

export function buildPdfMetadata(f: PackFurniture): PdfMetadata {
  return {
    title: `${f.companyName} — ${f.packLabel} — ${f.period}`,
    author: f.companyName,
    subject: f.draft ? `${f.packLabel} (draft) for ${f.period}` : `${f.packLabel} for ${f.period}`,
    creator: 'IsaFlow',
    // Each of these answers a question the title string cannot be parsed for
    // by a document management system indexing a forwarded pack: which
    // document type, over what period, final or not, and who may read it.
    custom: {
      [`${CUSTOM_PREFIX}Pack`]: f.packLabel,
      [`${CUSTOM_PREFIX}Company`]: f.companyName,
      [`${CUSTOM_PREFIX}Period`]: f.period,
      [`${CUSTOM_PREFIX}Status`]: f.draft ? 'DRAFT' : 'FINAL',
      [`${CUSTOM_PREFIX}Confidentiality`]: f.confidentiality,
    },
  };
}
