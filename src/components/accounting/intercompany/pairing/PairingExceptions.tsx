/** What cannot be paired: an amount mismatch, a document with no counterpart on the other side, a foreign-currency document. */
import { formatCurrency } from '@/utils/formatters';
import type { PairingDirection, PairingDoc, PairingMatches } from '@/modules/accounting/services/intercompany/pairingTypes';
import { DocCells, DocHeads, NUM, TD, TH } from './DocCells';
import { docLabels, sumCents } from './pairingFormat';

interface Props {
  matches: PairingMatches;
  partnerName: string;
  direction: PairingDirection;
}

function Block({ id, title, hint, count, children }: { id: string; title: string; hint: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <div className="space-y-2" data-testid={id}>
      <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">{title} ({count})</h3>
      <p className="text-xs text-ink-muted">{hint}</p>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

function SingleList({ caption, side, docs, showTotal = true }: { caption: string; side: string; docs: PairingDoc[]; showTotal?: boolean }) {
  return (
    <table className="min-w-full text-left">
      <caption className="sr-only">{caption}</caption>
      <thead><tr className="border-b border-[var(--ff-border-light)]"><DocHeads side={side} /></tr></thead>
      <tbody className="divide-y divide-[var(--ff-border-light)]">
        {docs.map((d) => <tr key={d.id}><DocCells doc={d} /></tr>)}
      </tbody>
      {showTotal && (
        <tfoot>
          <tr><td colSpan={3} className={`${TD} text-ink-muted`}>Open in total</td><td className={`${TD} ${NUM} font-medium`}>{formatCurrency(sumCents(docs.map((d) => d.open)))}</td></tr>
        </tfoot>
      )}
    </table>
  );
}

export function PairingExceptions({ matches, partnerName, direction }: Props) {
  const label = docLabels(direction, partnerName);
  const { mismatches, unmatchedMine, unmatchedTheirs, unsupported } = matches;
  const total = mismatches.length + unmatchedMine.length + unmatchedTheirs.length + unsupported.length;
  return (
    <section className="bg-[var(--ff-canvas-mid)] border border-[var(--ff-canvas-border)] rounded-xl p-5 space-y-5" aria-labelledby="ic-exc-h" data-testid="exceptions">
      <div>
        <h2 id="ic-exc-h" className="text-base font-semibold text-[var(--ff-text-primary)]">Exceptions ({total})</h2>
        <p className="text-xs text-ink-muted mt-1">
          These cannot be paired as they stand. Correct the document on the side that is wrong (or capture the missing one), then reload.
        </p>
      </div>
      {total === 0 && <p className="text-sm text-emerald-600 dark:text-emerald-400" data-testid="no-exceptions">No exceptions: every open document has a counterpart.</p>}
      <Block id="mismatches" title="Same number, different amount" count={mismatches.length}
        hint="The invoice number is the same on both sides but the totals disagree: one side was captured wrongly.">
        <table className="min-w-full text-left">
          <caption className="sr-only">Documents with the same number and different totals</caption>
          <thead><tr className="border-b border-[var(--ff-border-light)]"><DocHeads side={label.mine} /><DocHeads side={label.theirs} /><th scope="col" className={`${TH} text-right`}>Difference</th></tr></thead>
          <tbody className="divide-y divide-[var(--ff-border-light)]">
            {mismatches.map((m) => (
              <tr key={m.mine.id}>
                <DocCells doc={m.mine} /><DocCells doc={m.theirs} />
                <td className={`${TD} ${NUM} text-amber-700 dark:text-amber-400`}>{formatCurrency(Math.abs(sumCents([m.mine.total]) - sumCents([m.theirs.total])))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Block>
      <Block id="unmatched-mine" title="Only on your side" count={unmatchedMine.length}
        hint={`Open here, with no document of the same number open at ${partnerName}. It may be missing there, or numbered differently.`}>
        <SingleList caption="Your open documents with no counterpart" side={label.mine} docs={unmatchedMine} />
      </Block>
      <Block id="unmatched-theirs" title={`Only at ${partnerName}`} count={unmatchedTheirs.length}
        hint="Open there, with no document of the same number open here. It may not be captured in your books yet.">
        <SingleList caption="The partner's open documents with no counterpart" side={label.theirs} docs={unmatchedTheirs} />
      </Block>
      <Block id="unsupported" title="Foreign currency" count={unsupported.length}
        hint="Pairing is for rand documents only; these stay unpaired.">
        <SingleList caption="Foreign-currency documents" side="Document" docs={unsupported} showTotal={false} />
      </Block>
    </section>
  );
}
