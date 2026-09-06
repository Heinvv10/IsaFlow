/**
 * One fixed A4 page of a board pack — the shell around whatever a later task
 * renders as `children` (the page's blocks). This component computes no
 * figures and inlines no markup of its own; it only carries the page's own
 * layout metadata (orientation, footnotes, page number).
 *
 * Classes are the ones `packPrint.css` (Task 5) already styles —
 * `pack-page`, `pack-title`, `pack-section-heading`, `pack-footnotes` — not
 * new ones invented to match this file's own naming taste. `.pack-page`
 * already carries `break-after: page`, so no separate transport flag is
 * needed for pagination. `data-print-landscape` is the named-page attribute
 * print.css keys off (`@page landscape-page`), the one thing that IS new
 * here because no page in the pack was ever landscape before this task.
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
      className="pack-page"
      {...(page.orientation === 'landscape' ? { 'data-print-landscape': '' } : {})}
      id={`pack-page-${page.number}`}
    >
      <header>
        <h2 className="pack-title">{page.title}</h2>
        <span className="pack-section-heading">{page.section}</span>
      </header>
      {children}
      {page.footnotes.length > 0 && (
        <ol className="pack-footnotes">
          {page.footnotes.map((footnote) => (
            <li key={footnote.number}>{footnote.text}</li>
          ))}
        </ol>
      )}
    </section>
  );
}
