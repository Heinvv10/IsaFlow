/**
 * A report pack, paged.
 *
 * Unknown section types are DROPPED rather than rendered empty: a pack shown
 * on a boardroom screen must not page to a blank slide because a service
 * grew a section this deck has no renderer for.
 */

export interface ReportPack {
  type: 'board' | 'management' | 'monthly';
  companyName: string;
  period: string;
  generatedAt: string;
  sections: Array<{ type: string; title: string; data: Record<string, unknown> }>;
}

export type SlideKind =
  | 'cover' | 'income_statement' | 'balance_sheet' | 'cash_flow'
  | 'ratios' | 'kpis' | 'commentary' | 'waterfall' | 'trends';

export interface Slide {
  id: string;
  kind: SlideKind;
  title: string;
  data: Record<string, unknown>;
}

const RENDERABLE = new Set<SlideKind>([
  'income_statement', 'balance_sheet', 'cash_flow',
  'ratios', 'kpis', 'commentary', 'waterfall', 'trends',
]);

const PACK_LABEL: Record<ReportPack['type'], string> = {
  board: 'Board Pack',
  management: 'Management Pack',
  monthly: 'Monthly Pack',
};

export function buildSlides(pack: ReportPack): Slide[] {
  const slides: Slide[] = [
    {
      id: 'cover',
      kind: 'cover',
      title: `${pack.companyName} — ${PACK_LABEL[pack.type]}`,
      data: { period: pack.period, generatedAt: pack.generatedAt },
    },
  ];

  pack.sections.forEach((section, i) => {
    const kind = section.type as SlideKind;
    if (!RENDERABLE.has(kind)) return;
    slides.push({ id: `${kind}:${i}`, kind, title: section.title, data: section.data });
  });

  return slides;
}

export function clampSlide(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(index, 0), count - 1);
}
