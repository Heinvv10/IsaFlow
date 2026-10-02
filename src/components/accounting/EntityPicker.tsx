import { useState, useEffect, useRef } from 'react';
import { Search } from 'lucide-react';
import type { SelectOption } from './BankTxTable';

/** Reusable searchable dropdown for GL accounts, suppliers, or customers */
export function EntityPicker({
  label, placeholder, options, selected, onSelect,
}: {
  label: string; placeholder: string; options: SelectOption[];
  selected: SelectOption | null; onSelect: (o: SelectOption) => void;
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const filtered = search
    ? options.filter(o =>
        (o.code || '').toLowerCase().includes(search.toLowerCase()) ||
        o.name.toLowerCase().includes(search.toLowerCase())
      )
    : options;

  return (
    <div ref={ref}>
      <label className="text-xs text-[var(--ff-text-tertiary)] mb-1 block">{label}</label>
      <div className="relative">
        <button
          onClick={() => { setOpen(!open); setSearch(''); }}
          className={`w-full text-left px-3 py-2 rounded border text-sm ${
            selected
              ? 'bg-[var(--ff-bg-primary)] border-[var(--ff-border-light)] text-[var(--ff-text-primary)]'
              : 'bg-[var(--ff-bg-primary)] border-amber-500/40 text-amber-400'
          }`}
        >
          {selected ? `${selected.code || ''} ${selected.name}`.trim() : placeholder}
        </button>
        {open && (
          <div className="absolute z-50 top-full left-0 mt-1 w-full bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg shadow-xl">
            <div className="p-2">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-[var(--ff-text-tertiary)]" />
                <input
                  type="text"
                  placeholder={`Search...`}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="w-full pl-7 pr-2 py-1.5 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)] focus:outline-none focus:border-blue-500"
                  autoFocus
                />
              </div>
            </div>
            <div className="max-h-48 overflow-y-auto">
              {filtered.slice(0, 50).map(o => (
                <button
                  key={o.id}
                  onClick={() => { onSelect(o); setOpen(false); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--ff-bg-primary)] text-xs flex items-center gap-2"
                >
                  {o.code && <span className="font-mono text-[var(--ff-text-tertiary)] w-10 shrink-0">{o.code}</span>}
                  <span className="text-[var(--ff-text-primary)] truncate">{o.name}</span>
                </button>
              ))}
              {filtered.length === 0 && (
                <div className="px-3 py-2 text-xs text-[var(--ff-text-tertiary)]">No results found</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
