/**
 * The two prose blocks a pack page can carry that are neither commentary nor
 * a statement: a disclosure (a heading and its notes) and the definitions
 * list on page 12.
 *
 * A definition of a non-IFRS measure carries its RECONCILIATION as figures,
 * not as prose — spec §7.1 criterion 12 fails a pack where an adjusted
 * measure has no bridge, and a sentence claiming one is not a bridge. That
 * is why this file takes the document's scale: the reconciliation steps are
 * money and must print in the same unit as the statements they bridge to.
 */
import { formatFigureText } from '../primitives/packFigureText';
import { FootnoteMarker } from '../primitives/FootnoteMarker';
import type { MoneyScale } from '@/lib/format/money';
import { PACK_TABLE_COLUMN_LABEL } from '@/modules/accounting/services/packs/pages/packBlockModel';
import type {
  PackDefinition,
  PackDisclosure,
} from '@/modules/accounting/services/packs/pages/packPageModel';

export interface PackDisclosureBlockProps {
  disclosure: PackDisclosure;
}

export function PackDisclosureBlock({ disclosure }: PackDisclosureBlockProps) {
  return (
    <div className={disclosure.columns === 2 ? 'pack-disclosure is-two-column' : 'pack-disclosure'}>
      <h3 className="pack-disclosure-heading">{disclosure.heading}</h3>
      {disclosure.notes.map((note, index) => (
        <p key={`${note.heading}-${index}`} className="pack-disclosure-body">
          <span className="pack-disclosure-note-heading">{note.heading}</span>
          <FootnoteMarker number={note.footnote ?? null} />
          {' '}
          {note.body}
        </p>
      ))}
    </div>
  );
}

export interface PackDefinitionsBlockProps {
  entries: PackDefinition[];
  /** The document's `numberConvention.scale` — see `formatFigureText`. */
  scale: MoneyScale;
}

export function PackDefinitionsBlock({ entries, scale }: PackDefinitionsBlockProps) {
  return (
    <dl className="pack-definitions">
      {entries.map((entry) => (
        <div key={entry.term} className="pack-definition">
          <dt className="pack-definition-term">{entry.term}</dt>
          <dd className="pack-definition-body">
            {entry.definition}
            {entry.reconciliation && entry.reconciliation.length > 0 && (
              <table className="pack-table pack-definition-bridge">
                {/* A SECOND COLUMN NEEDS A HEADING; ONE DOES NOT.
                    A bare pair of money columns says nothing about which
                    period is which, and the comparative bridge exists
                    precisely because a reader could not tell a comparative
                    add-back of nil from one the pack never computed. Drawn
                    off the steps rather than off a flag, so a bridge with no
                    comparative prints exactly the single-column table it
                    printed before. */}
                {entry.reconciliation.some((step) => step.comparative !== undefined) && (
                  <thead>
                    <tr>
                      <th scope="col" />
                      {/* THE PACK'S OWN COLUMN WORDS, not a second pair. Every
                          statement in the document heads its two periods
                          Actual and Prior, and this bridge is read against
                          them; "Reporting period / Comparative" would be a
                          third vocabulary for one idea — and two long
                          headings wrap inside a glossary column, which the
                          height model cannot see. */}
                      <th scope="col">{PACK_TABLE_COLUMN_LABEL.actual}</th>
                      <th scope="col">{PACK_TABLE_COLUMN_LABEL.prior}</th>
                    </tr>
                  </thead>
                )}
                <tbody>
                  {entry.reconciliation.map((step, index) => (
                    <tr key={`${step.label}-${index}`}>
                      <td>{step.label}</td>
                      <td>{formatFigureText(step.figure, scale)}</td>
                      {step.comparative !== undefined && (
                        <td>{formatFigureText(step.comparative, scale)}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {entry.reconciliationNote && (
              <p className="pack-definition-bridge-note">{entry.reconciliationNote}</p>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
