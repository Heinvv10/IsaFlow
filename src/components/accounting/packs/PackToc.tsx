/**
 * The pack's table of contents.
 *
 * Sections are numbered, not page-numbered: HTML cannot know which page a
 * section lands on, and a wrong page number in a table of contents is worse
 * than none. The printed page number is in the running footer, which the
 * renderer draws (the footer template in src/lib/pdf/transports/).
 */
import type { PackDocument } from '@/modules/accounting/services/packs/packDocument';

export function PackToc({ document }: { document: PackDocument }) {
  return (
    <section data-pack-toc className="space-y-4">
      <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Contents</h2>
      <ol className="space-y-1 text-sm text-[var(--ff-text-secondary)]">
        {document.sections.map((section, i) => (
          <li key={section.type}>{`${i + 1}. ${section.title}`}</li>
        ))}
      </ol>
    </section>
  );
}
