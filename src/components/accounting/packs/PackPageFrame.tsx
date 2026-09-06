/**
 * One fixed A4 page of a board pack — the shell around whatever a later task
 * renders as `children` (the page's blocks). This component computes no
 * figures and inlines no markup of its own; it only carries the page's own
 * layout metadata (orientation, footnotes, page number).
 *
 * `data-print-break` reuses the pagination rule print.css already defines for
 * the legacy `PackSectionView` — every page starts a new sheet, cover
 * included, same as every section does today. `data-print-landscape` is the
 * named-page attribute print.css keys off (`@page landscape-page`), not a
 * flag read by the PDF transport itself.
 */
import type { ReactNode } from 'react';
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';

export interface PackPageFrameProps {
  page: PackPage;
  children?: ReactNode;
}

export function PackPageFrame({ page, children }: PackPageFrameProps) {
  return (
    <section
      className={`pack-page pack-page--${page.orientation} pack-page--density-${page.density}`}
      data-print-break
      {...(page.orientation === 'landscape' ? { 'data-print-landscape': '' } : {})}
      id={`pack-page-${page.number}`}
    >
      <header className="pack-page__header">
        <h2 className="pack-page__title">{page.title}</h2>
        <span className="pack-page__section">{page.section}</span>
      </header>
      <div className="pack-page__body">{children}</div>
      {page.footnotes.length > 0 && (
        <ol className="pack-page__footnotes">
          {page.footnotes.map((footnote) => (
            <li key={footnote.number}>{footnote.text}</li>
          ))}
        </ol>
      )}
      <div className="pack-page__pageno">{page.number}</div>
    </section>
  );
}
