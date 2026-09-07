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
      {/* `pack-page-header`, and the class is load-bearing rather than a
        * styling hook: `styles/print.css` hides `header` to strip AppLayout's
        * chrome from a printed page, and a bare `header` selector took every
        * page title in the pack with it. See that rule for what the reader
        * received. */}
      <header className="pack-page-header">
        {/* THE PAGE SAYS WHICH PAGE IT IS, in the words the Contents uses.
          *
          * `title` is a CONCLUSION by rule (`assertPageTitleIsAMessage`) —
          * "Gross margin is a negative 1348.0%, carrying operating expenses
          * of 226." — and for four of the ten content sheets that conclusion
          * never happened to begin with the page's name. A director turning
          * to sheet 6 from a Contents page promising "Income statement" found
          * nothing on it saying so.
          *
          * So `navLabel` — the same string the Contents prints, not a second
          * spelling of it — is the page's HEADING, and the derived conclusion
          * is the standfirst beneath it. That also settles the hierarchy the
          * re-review flagged: the heading was 13pt against 24pt KPI figures,
          * which read as a caption. The section eyebrow moves onto the
          * heading's own line, right-aligned, so the header still costs two
          * lines of paper rather than three — the pack's slack is measured in
          * millimetres. */}
        <div className="pack-page-heading-row">
          <h2 className="pack-page-name">{page.navLabel}</h2>
          <span className="pack-section-heading">{page.section}</span>
        </div>
        <p className="pack-title">{page.title}</p>
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
