/**
 * The two ways BillLineItemsTable lays the same line controls out: a wide table (a Description with a real floor,
 * a GL account that reads as a name), and, when the card is too narrow for those columns, one stacked card per
 * line with the description on its own full-width row. Both take the controls from billLineFields.
 */
import type { ReactNode } from 'react';
import type { LineFields } from './BillLineFields';

const th = 'py-2.5 text-xs font-semibold text-ink-muted';
const cap = 'mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400';

function Captioned({ text, field, children }: { text: string; field?: string; children: ReactNode }) {
  return <div data-field={field} className="min-w-0"><span className={cap}>{text}</span>{children}</div>;
}

export function BillLinesTable({ rows, showDimensions }: { rows: { key: string; f: LineFields }[]; showDimensions: boolean }) {
  return (
    <table className="w-full min-w-[720px] text-sm">
      <thead className="bg-slate-50 dark:bg-slate-800/60">
        <tr>
          <th className={`${th} px-4 text-left min-w-[220px]`}>Description</th>
          <th className={`${th} px-3 text-left min-w-[11rem] w-44`}>GL Account</th>
          {showDimensions && <th className={`${th} px-3 text-left w-44`}>CC2 project</th>}
          {showDimensions && <th className={`${th} px-3 text-left w-32`}>BU</th>}
          <th className={`${th} px-3 text-right w-20`}>Qty</th>
          <th className={`${th} px-3 text-right w-28`}>Unit Price</th>
          <th className={`${th} px-4 text-right w-28`}>Total</th>
          <th className="w-9" />
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
        {rows.map(({ key, f }) => (
          <tr key={key} data-line-key={key} className="group hover:bg-slate-50/50 dark:hover:bg-slate-800/20 transition-colors">
            <td data-field="description" className="px-3 py-2 align-top">{f.description}</td>
            <td data-field="account" className="px-3 py-2 align-top">{f.account}</td>
            {showDimensions && <td data-field="cc2" className="px-3 py-2 align-top">{f.cc2}</td>}
            {showDimensions && <td data-field="bu" className="px-3 py-2 align-top">{f.bu}</td>}
            <td data-field="qty" className="px-3 py-2 align-top">{f.qty}</td>
            <td data-field="price" className="px-3 py-2 align-top">{f.price}</td>
            <td className="px-4 py-4 text-right tabular-nums text-sm font-semibold text-slate-800 dark:text-slate-200 align-top">{f.total}</td>
            <td data-field="remove" className="px-2 py-2 align-top">{f.remove}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function BillLinesCards({ rows, showDimensions, oneColumn }: {
  rows: { key: string; f: LineFields }[]; showDimensions: boolean; oneColumn: boolean;
}) {
  const pair = oneColumn ? 'grid-cols-1' : 'grid-cols-2';
  return (
    <ul className="space-y-3">
      {rows.map(({ key, f }, i) => (
        <li key={key} data-line-key={key} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-3">
          <div>
            <span className={cap}>Line {i + 1} description</span>
            <div className="flex items-center gap-2">
              <div data-field="description" className="min-w-0 flex-1">{f.description}</div>
              <div data-field="remove">{f.remove}</div>
            </div>
          </div>
          <Captioned text="GL Account" field="account">{f.account}</Captioned>
          {showDimensions && (
            <div className={`grid ${pair} gap-3`}>
              <Captioned text="CC2 project" field="cc2">{f.cc2}</Captioned>
              <Captioned text="BU" field="bu">{f.bu}</Captioned>
            </div>
          )}
          <div className={`grid ${oneColumn ? 'grid-cols-2' : 'grid-cols-3'} gap-3`}>
            <Captioned text="Qty" field="qty">{f.qty}</Captioned>
            <Captioned text="Unit Price" field="price">{f.price}</Captioned>
            <Captioned text="Total">
              <p className="py-2 text-right tabular-nums text-sm font-semibold text-slate-800 dark:text-slate-200">{f.total}</p>
            </Captioned>
          </div>
        </li>
      ))}
    </ul>
  );
}
