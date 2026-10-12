/**
 * "Compare to today": what changed in the books for a snapshot's cutoff since
 * it was taken — backdated, changed (field by field), removed and reversed
 * journals, the accounts whose closing balance moved, and master-data changes.
 */
import type { ReactNode } from 'react';
import { fmtAmount, fmtAt, type Comparison, type JournalItem } from './auditSnapshotApi';

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="border border-[rgba(255,255,255,0.06)] rounded-lg">
      <h3 className="px-3 py-2 text-sm font-medium text-slate-200 border-b border-[rgba(255,255,255,0.06)] flex justify-between">
        {title}<span className={count > 0 ? 'text-amber-300' : 'text-slate-500'}>{count}</span>
      </h3>
      {count > 0 && <div className="p-3 text-xs space-y-2">{children}</div>}
    </section>
  );
}

function Journal({ j, extra, names }: { j: JournalItem; extra?: string | null; names: Record<string, string> }) {
  const who = (id: string | null) => (id ? names[id] ?? id.slice(0, 8) : '—');
  return (
    <div className="text-slate-300">
      <span className="text-slate-100 font-medium">{j.entryNumber ?? j.id.slice(0, 8)}</span> dated {j.entryDate} — created {fmtAt(j.createdAt)} by{' '}
      <span>{who(j.createdBy)}</span>, posted {fmtAt(j.postedAt)} by {who(j.postedBy)}{extra ? ` · ${extra}` : ''}
      {j.fields.map((f) => <div key={f.field} className="pl-4 text-slate-400">{f.field}: <span className="text-red-300 line-through">{f.before ?? '∅'}</span> → <span className="text-teal-300">{f.after ?? '∅'}</span></div>)}
      {j.lines.changed.flatMap((l) => l.fields.map((f) => (
        <div key={`${l.id}.${f.field}`} className="pl-4 text-slate-400">line {l.id.slice(0, 8)} {f.field}: <span className="text-red-300 line-through">{f.before ?? '∅'}</span> → <span className="text-teal-300">{f.after ?? '∅'}</span></div>
      )))}
      {(j.lines.added > 0 || j.lines.removed > 0) && <div className="pl-4 text-slate-500">lines added {j.lines.added}, removed {j.lines.removed}</div>}
    </div>
  );
}

export function ComparisonView({ c }: { c: Comparison }) {
  const notCompared = [...(c.notCompared?.journals ?? []).map((f) => `journal ${f}`), ...(c.notCompared?.lines ?? []).map((f) => `line ${f}`)];
  return (
    <div className="p-4 space-y-3">
      <p className="text-xs text-slate-500">
        Snapshot taken {fmtAt(c.base.takenAt)} at cutoff {c.base.cutoff}, compared with {c.against.kind === 'live' ? 'today’s books' : 'a later snapshot'} as at {fmtAt(c.against.takenAt)}.
        Backdated = dated on or before the cutoff but not in the snapshot: it entered the frozen period after the freeze.
        Both sides verified before comparing ({c.verification.base}{c.verification.against ? ` / ${c.verification.against}` : ''}).
      </p>
      {notCompared.length > 0 && (
        <p className="text-xs text-amber-300">Not compared (frozen by only one side, e.g. a snapshot taken before these columns were frozen): {notCompared.join(', ')}.</p>
      )}
      <Section title="Journals that entered the frozen period after the snapshot (backdated)" count={c.counts.backdated ?? 0}>
        {c.backdated.map((j) => <Journal key={j.id} j={j} names={c.names}
          extra={j.recordedAfter ? null : 'recorded BEFORE the snapshot — re-dated into the period, committed late or flipped to posted'} />)}
      </Section>
      <Section title="Changed journals" count={c.counts.changed ?? 0}>{c.changed.map((j) => <Journal key={j.id} j={j} names={c.names} />)}</Section>
      <Section title="Reversed after the snapshot" count={c.counts.reversedAfter ?? 0}>
        {c.changed.filter((j) => c.reversedAfter.includes(j.id)).map((j) => <Journal key={j.id} j={{ ...j, fields: j.fields.filter((f) => f.field.startsWith('reversed')) }} names={c.names} />)}
      </Section>
      <Section title="Removed journals" count={c.counts.removed ?? 0}>{c.removed.map((j) => <Journal key={j.id} j={j} extra={j.statusNow ? `now ${j.statusNow}` : null} names={c.names} />)}</Section>
      <Section title="Accounts whose closing balance moved" count={c.tb.length}>
        <table className="w-full">
          <thead><tr className="text-slate-500 text-left"><th>Account</th><th className="text-right">Snapshot</th><th className="text-right">Now</th><th className="text-right">Movement</th></tr></thead>
          <tbody>{c.tb.map((t) => (
            <tr key={t.accountId} className="text-slate-300"><td>{t.code} {t.name}</td><td className="text-right">{fmtAmount(t.before)}</td>
              <td className="text-right">{fmtAmount(t.after)}</td><td className="text-right text-amber-300">{fmtAmount(t.delta)}</td></tr>
          ))}</tbody>
        </table>
      </Section>
      {c.masterData && (
        <Section title="Master-data changes since the snapshot" count={c.masterData.total}>
          <p className="text-slate-400">{Object.entries(c.masterData.byType).map(([t, n]) => `${t.replace(/_/g, ' ')}: ${n}`).join(' · ')}{c.masterData.truncated ? ' (first 1 000 only)' : ''}</p>
          {c.masterData.items.map((i) => (
            <div key={`${i.entityId}-${i.recordedAt}`} className="text-slate-300">{fmtAt(i.recordedAt)} · {i.type.replace(/_/g, ' ')} {i.label ?? i.entityId.slice(0, 8)} · {i.op} by {i.actorName ?? i.actor}</div>
          ))}
        </Section>
      )}
    </div>
  );
}
