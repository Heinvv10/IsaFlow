/**
 * The 12-page pack's table of contents. Unlike the legacy `PackToc`, this
 * pack IS page-numbered — `PackPage.number` is fixed by spec §4 rather than
 * inferred from section order, so listing it here is accurate, not a guess
 * about layout.
 *
 * `data-pack-toc` is the attribute `styles/print.css` already keys its
 * cover/contents page-break rule off; reused rather than inventing a second
 * one for the same purpose.
 */
import type { ReactNode } from 'react';
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';

export interface PackContentsProps {
  pages: Pick<PackPage, 'number' | 'title'>[];
  /** Page 2's own blocks — spec §4.A page 2 puts a one-line basis-of-
   *  preparation note at the foot of the contents, and that note is model
   *  content rather than something this component may compose. */
  children?: ReactNode;
}

export function PackContents({ pages, children }: PackContentsProps) {
  return (
    <section data-pack-toc className="pack-page">
      <h2 className="pack-title">Contents</h2>
      <ol className="pack-contents-list">
        {pages.map((page) => (
          <li key={page.number} className="pack-contents-item">
            <span className="pack-contents-number">{page.number}</span>
            <span className="pack-contents-title">{page.title}</span>
          </li>
        ))}
      </ol>
      {children}
    </section>
  );
}
