/**
 * Read-only pack, rendered for someone with no session. No AppLayout, no nav,
 * no links back into the app, no annotations, no draft commentary — the props
 * this component accepts cannot express any of those.
 */
import { Fragment } from 'react';
import { CommentaryBlock, type PublishedCommentaryRow } from '@/components/accounting/commentary/CommentaryBlock';
import { formatMoney } from '@/lib/format/money';
import { ManagementPandLRows, ManagementBalanceSheetRows } from '@/components/accounting/ManagementPandLRows';
import {
  packToTotals, packToMargins, packToBsTotals, packToBsDetail,
} from '@/modules/accounting/services/reports/statementRows/packMappers';
import { NO_MARGIN_REASON } from '@/modules/accounting/services/packs/packDocument';
import type { PublishedCommentary, SharedPack } from '@/modules/accounting/services/share/sharedPackService';
import { OMITTED_SECTIONS, type SharedReportPack } from '@/modules/accounting/services/share/sharedSections';

/** Exactly what a shared link renders — the builder's output minus everything
 *  the view does not draw. `SharedPack`'s `unclassifiedAccounts` is absent by
 *  construction, so it cannot reach the page props by being forgotten. */
export type SharedPackProps = Pick<SharedPack, 'companyName' | 'period' | 'commentary'> & {
  pack: SharedReportPack;
};

/** The share page's rows onto the ONE published renderer's type.
 *
 *  `loadApprovedCommentary` already filtered on `status = 'approved'` and
 *  `approved_text IS NOT NULL` server-side; restating the status here is what
 *  lets these rows go through `CommentaryBlock` — which re-checks it — rather
 *  than through a second renderer with its own, unwritten safety argument.
 *  There is no id on a published row, so the section/row pair is the key, the
 *  same one the old local renderer used. */
function toPublishedRows(commentary: PublishedCommentary[]): PublishedCommentaryRow[] {
  return commentary.map(c => ({
    id: `${c.sectionRef}:${c.rowRef}`,
    sectionRef: c.sectionRef,
    status: 'approved' as const,
    approvedText: c.text,
  }));
}

/** camelCase key → the words a reader outside the company can follow. */
function labelFor(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
}

function hasNotes(commentary: PublishedCommentary[], sectionRef: string): boolean {
  return commentary.some(c => c.sectionRef === sectionRef);
}

function Note({ children }: { children: string }) {
  return <p className="text-sm italic text-[var(--ff-text-tertiary)]">{children}</p>;
}

/**
 * The two margins.
 *
 * `packToMargins` became nullable when WS2 landed: turnover of zero or less
 * has no margin, because dividing by a negative prints a healthy-looking
 * POSITIVE percentage. This line called `.toFixed(1)` on the result, so a link
 * shared on a loss-making period would have thrown the whole page to its error
 * boundary — for a recipient with no session, no nav and no way back.
 *
 * The reason string is the owner-side one (`NO_MARGIN_REASON`, printed by
 * `formatPackKv` on the screen and in the PDF) rather than a second wording
 * for the same fact. The percentage keeps this page's own unsigned form: the
 * shared pack has read that way since it shipped, and the crash is what needed
 * fixing.
 */
function MarginLine({ data }: { data: Record<string, unknown> }) {
  const { grossMargin, netMargin } = packToMargins(data);
  const pct = (m: number | null) => (m === null ? NO_MARGIN_REASON : `${m.toFixed(1)}%`);
  return (
    <p className="mt-2 text-xs text-[var(--ff-text-tertiary)]">
      Gross margin {pct(grossMargin)} · Net margin {pct(netMargin)}
    </p>
  );
}

export function SharedPackView({ data }: { data: SharedPackProps }) {
  const published = toPublishedRows(data.commentary);
  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <header className="mb-8 border-b border-[var(--ff-border-light)] pb-4">
        <h1 className="text-2xl font-semibold text-[var(--ff-text-primary)]">{data.companyName}</h1>
        <p className="text-sm text-[var(--ff-text-tertiary)]">
          {data.pack.type.charAt(0).toUpperCase() + data.pack.type.slice(1)} pack · {data.period.from} to {data.period.to}
        </p>
      </header>

      {data.pack.sections.map(section => (
        <section key={section.type} className="mb-8" data-section={section.type}>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-[var(--ff-text-tertiary)]">
            {section.title}
          </h2>
          {section.type === 'income_statement' && (
            <Fragment>
              <ManagementPandLRows is={packToTotals(section.data ?? {})} />
              <MarginLine data={section.data ?? {}} />
            </Fragment>
          )}
          {section.type === 'balance_sheet' && (
            <ManagementBalanceSheetRows bs={packToBsTotals(section.data ?? {})} detail={packToBsDetail(section.data ?? {})} />
          )}
          {OMITTED_SECTIONS.has(section.type) && (
            <Note>Not included on shared links.</Note>
          )}
          {/* The pack's own `commentary` section carries a generated summary.
              A shared link shows APPROVED text only, which CommentaryFor
              renders below, so this body is just the empty-state. */}
          {section.type === 'commentary' && !hasNotes(data.commentary, 'commentary') && (
            <Note>No approved commentary for this period.</Note>
          )}
          {section.type !== 'income_statement' && section.type !== 'balance_sheet'
            && section.type !== 'commentary' && !OMITTED_SECTIONS.has(section.type) && (
            <dl className="grid grid-cols-2 gap-2 text-sm md:grid-cols-3">
              {Object.entries(section.data ?? {})
                .filter(([, v]) => typeof v === 'number')
                .map(([k, v]) => (
                  <div key={k} className="rounded border border-[var(--ff-border-light)] p-2">
                    <dt className="text-xs text-[var(--ff-text-tertiary)]">{labelFor(k)}</dt>
                    <dd className="tabular-nums text-[var(--ff-text-primary)]">{formatMoney(v as number)}</dd>
                  </div>
                ))}
            </dl>
          )}
          <CommentaryBlock mode="published" sectionRef={section.type} rows={published} />
        </section>
      ))}

      <footer className="mt-10 border-t border-[var(--ff-border-light)] pt-4 text-xs text-[var(--ff-text-tertiary)]">
        Shared read-only from IsaFlow. This link expires and can be withdrawn at any time.
      </footer>
    </main>
  );
}
