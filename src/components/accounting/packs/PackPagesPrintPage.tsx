/**
 * The whole of `/accounting/reports/report-packs?print=1&pack=board`.
 *
 * The fixed-page counterpart of `PackPrintPage`, and a sibling rather than a
 * branch inside it for the same reason that one is a sibling of the
 * interactive screen: each half owns its own data hook, and the page's
 * default export has to stay a dispatcher.
 *
 * No AppLayout, and exactly one fetch — the path the print token authorises
 * for a board pack. See `printRenderQuery.ts` for why a stray fetch during a
 * print render is not merely wasteful but destroys the render's own auth.
 */
import { PackPagesView } from './PackPagesView';
import { usePackPagesData } from './usePackPagesData';
import type { PackType } from '@/modules/accounting/services/reports/reportPackService';

export interface PackPagesPrintPageProps {
  packType: PackType;
  from: string;
  to: string;
}

export function PackPagesPrintPage({ packType, from, to }: PackPagesPrintPageProps) {
  const { document, error } = usePackPagesData(packType, from, to);

  // Never print-ready: the renderer times out loudly rather than
  // photographing a pack with a hole in it. This is also where a REFUSED
  // chart surfaces — `adoptPackPagesDocument` throws rather than returning a
  // document with unvetted markup in it. The text is for a human who opens
  // the same URL in a browser and needs to know why nothing rendered.
  if (error) {
    return <p className="p-8 text-sm text-[var(--ff-text-secondary)]">This pack could not be built: {error}</p>;
  }

  return <PackPagesView document={document} />;
}
