/**
 * The pack's cover page. Names the company, the pack and the period, and
 * nothing else — a reader who is handed page one of a forwarded PDF must be
 * able to say whose numbers these are and which months they cover.
 *
 * `document` is the PackDocument prop, so this file never touches the global
 * `document`; every DOM reference lives in usePrintMode.ts.
 */
import { PACK_LABELS } from '@/modules/accounting/services/packs/packSections';
import type { PackDocument } from '@/modules/accounting/services/packs/packDocument';

export function PackCover({ document }: { document: PackDocument }) {
  // Date only. The pack is a period document; the minute it was generated is
  // noise on a cover, and a UTC timestamp on an SAST page invites a wrong
  // reading of the day.
  const generated = document.generatedAt.slice(0, 10);

  return (
    <section data-pack-cover className="flex h-[240mm] flex-col justify-center gap-6 text-center">
      <p className="text-sm uppercase tracking-[0.3em] text-[var(--ff-text-tertiary)]">
        Prepared under IFRS for SMEs
      </p>
      <h1 className="text-4xl font-bold text-[var(--ff-text-primary)]">{document.companyName}</h1>
      <p className="text-2xl text-[var(--ff-text-secondary)]">{PACK_LABELS[document.packType]}</p>
      <p className="text-base text-[var(--ff-text-secondary)]">{document.period}</p>
      <p className="text-xs text-[var(--ff-text-tertiary)]">Generated {generated}</p>
    </section>
  );
}
