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
import { FootnoteList } from './primitives/FootnoteList';

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
        {/* THE CONCLUSION IS THE HEADING; THE PAGE'S NAME IS THE EYEBROW.
          *
          * Both elements have been on the page for some time and only their
          * type ranks were wrong. `navLabel` was the H1 and `title` — a
          * CONCLUSION by rule (`assertPageTitleIsAMessage`) — was a standfirst
          * beneath it at 12pt against 16pt, so the largest, darkest thing on
          * every one of the ten content sheets was a category noun: a board
          * read "Group results" first and "An operating loss of (1 545) on
          * revenue of 101" second. The benchmark inverts that, and the spec
          * asks for a title that states a conclusion about the period, which a
          * half-size subtitle under a label is not.
          *
          * The name is not dropped, because a director turning to a sheet from
          * a Contents page promising "Income statement" has to find it: it
          * runs as the eyebrow, in the same small caps as the section beside
          * it, in the same words the Contents prints. It keeps
          * `.pack-page-name` so the print harness's positional guard still
          * reads the page's name where the page's name now is.
          *
          * The header still costs two lines of paper — the eyebrow row is
          * cheaper than the old 19pt heading line by about as much as the
          * conclusion gains going up to 15pt. */}
        <div className="pack-page-heading-row">
          <p className="pack-page-name">{page.navLabel}</p>
          <span className="pack-section-heading">{page.section}</span>
        </div>
        <h2 className="pack-title">{page.title}</h2>
      </header>
      {children}
      <FootnoteList footnotes={page.footnotes} />
    </section>
  );
}
