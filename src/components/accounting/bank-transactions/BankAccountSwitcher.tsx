/**
 * BankAccountSwitcher — the "All accounts" combobox of the bank card row once there are more than
 * SWITCHER_THRESHOLD accounts (WP5). Search by name, code or account number; each account shows its ledger balance
 * and "N to code"; sub-account groups list their sub-accounts under them. Keyboard only: open it (Enter / ArrowDown),
 * type, ArrowUp / ArrowDown / Home / End, Enter picks, Escape closes, Alt+P pins or unpins the active row's card.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, Pin, PinOff, Search } from 'lucide-react';
import { fmtCents } from './bankCents';
import { MiddleTruncate } from './MiddleTruncate';
import { ToCodeLine } from './ToCodeLine';
import { searchAccounts, type SwitcherRow } from './bankCardPins';
import type { BankAccountGroup } from './groupBankAccounts';
import type { BankAccountSummary } from './useBankTxSummary';

interface Props {
  primaries: BankAccountSummary[];
  groups: BankAccountGroup[];
  accountCount: number;
  selectedBank: string;
  /** Card keys that are pinned (primary id, or `group:<id>`). */
  pinned: ReadonlySet<string>;
  /** The selected account's name when no pinned card shows it, so the closed control still says where you are. */
  outsideSelection: string | null;
  onPick: (account: BankAccountSummary, groupId: string | null) => void;
  onTogglePin: (cardKey: string) => void;
}

const isOption = (r: SwitcherRow): r is Extract<SwitcherRow, { kind: 'account' }> => r.kind === 'account';

function PinButton({ cardKey, name, pinned, onToggle }: { cardKey: string; name: string; pinned: boolean; onToggle: (k: string) => void }) {
  const Icon = pinned ? PinOff : Pin;
  return (
    <button type="button" tabIndex={-1} aria-pressed={pinned} data-testid="bank-switcher-pin"
      aria-label={`${pinned ? 'Unpin' : 'Pin'} ${name}`} title={pinned ? 'Unpin card' : 'Pin as a card'}
      onMouseDown={e => e.preventDefault()} onClick={e => { e.stopPropagation(); onToggle(cardKey); }}
      className="shrink-0 rounded p-1 text-[var(--ff-text-tertiary)] hover:bg-[var(--ff-bg-tertiary)] hover:text-teal-700">
      <Icon className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}

export function BankAccountSwitcher({ primaries, groups, accountCount, selectedBank, pinned, outsideSelection, onPick, onTogglePin }: Props) {
  const uid = useId();
  const listId = `${uid}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const rows = useMemo(() => searchAccounts(primaries, groups, query), [primaries, groups, query]);
  const options = useMemo(() => rows.filter(isOption), [rows]);
  const current = options[Math.min(active, options.length - 1)];

  useEffect(() => {
    if (!open) return undefined;
    input.current?.focus();
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    if (open && current) document.getElementById(`${uid}-${current.account.id}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, current, uid]);

  const close = () => { setOpen(false); setQuery(''); trigger.current?.focus(); };
  const pick = (o: Extract<SwitcherRow, { kind: 'account' }>) => { onPick(o.account, o.groupId); close(); };
  const cardKeyOf = (o: Extract<SwitcherRow, { kind: 'account' }>) => (o.groupId ? `group:${o.groupId}` : o.account.id);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const last = options.length - 1;
    if (e.key === 'ArrowDown') setActive(a => Math.min(last, a + 1));
    else if (e.key === 'ArrowUp') setActive(a => Math.max(0, a - 1));
    else if (e.key === 'Home' && !query) setActive(0);
    else if (e.key === 'End' && !query) setActive(last);
    else if (e.key === 'Enter' && current) pick(current);
    else if (e.key === 'Escape') close();
    else if (e.altKey && e.code === 'KeyP' && current) onTogglePin(cardKeyOf(current)); // e.code: macOS Option+P types π
    else return;
    e.preventDefault();
  };

  // Primaries stand alone; a group's heading wraps its sub-accounts (role=group inside the listbox).
  const sections = useMemo(() => {
    const out: { group?: Extract<SwitcherRow, { kind: 'group' }>; items: Extract<SwitcherRow, { kind: 'account' }>[] }[] = [];
    for (const r of rows) {
      if (r.kind === 'group') out.push({ group: r, items: [] });
      else if (r.groupId && out.length > 0 && out[out.length - 1]!.group) out[out.length - 1]!.items.push(r);
      else out.push({ items: [r] });
    }
    return out;
  }, [rows]);
  const renderOption = (r: Extract<SwitcherRow, { kind: 'account' }>) => {
    const a = r.account;
    const idx = options.indexOf(r);
    const isActive = idx === Math.min(active, options.length - 1);
    return (
      <li key={r.key} id={`${uid}-${a.id}`} role="option" aria-selected={isActive}
        aria-current={a.id === selectedBank ? 'true' : undefined} data-testid="bank-switcher-option" data-account-id={a.id}
        onMouseMove={() => setActive(idx)} onClick={() => pick(r)}
        className={`flex cursor-pointer items-center gap-2 py-1.5 pr-3 ${r.groupId ? 'pl-7' : 'pl-3'} ${
          isActive ? 'bg-teal-500/10' : ''} ${a.isActive ? '' : 'opacity-70'}`}>
        <span className="min-w-0 flex-1">
          <MiddleTruncate name={a.accountName} className="text-sm font-medium text-[var(--ff-text-primary)]" />
          <span className="block truncate text-xs text-[var(--ff-text-tertiary)] font-id">
            {a.accountCode}{a.bankAccountNumber && ` | ****${a.bankAccountNumber.slice(-4)}`}{a.isActive ? '' : ' | Inactive'}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span data-testid="switcher-ledger" className="block text-sm font-bold tabular-nums">{fmtCents(a.ledgerCents)}</span>
          <ToCodeLine toCode={a.counts.toCode} inCents={a.toCodeInCents} outCents={a.toCodeOutCents} />
        </span>
        {!r.groupId && <PinButton cardKey={r.key} name={a.accountName} pinned={pinned.has(r.key)} onToggle={onTogglePin} />}
      </li>
    );
  };

  // The popup's onMouseDown preventDefault keeps a press inside it from blurring the search box (the blur-close would
  // eat the click).
  const label = outsideSelection ?? 'All accounts';
  return (
    <div ref={root} className="relative shrink-0" data-testid="bank-account-switcher"
      // Focus leaving the control closes it, to the page or to the browser chrome (relatedTarget null).
      onBlur={e => { if (open && !root.current?.contains(e.relatedTarget as Node | null)) { setOpen(false); setQuery(''); } }}>
      <button ref={trigger} type="button" aria-haspopup="listbox" aria-expanded={open} data-testid="bank-switcher-trigger"
        aria-label={outsideSelection ? `All accounts, current: ${outsideSelection}` : `All accounts (${accountCount})`}
        aria-current={outsideSelection ? 'true' : undefined}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={e => { if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setOpen(true); } }}
        className={`flex h-full w-[220px] items-center justify-between gap-2 rounded-lg border-2 px-4 py-2.5 text-left text-sm font-semibold ${
          outsideSelection ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-400'
            : 'border-dashed border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] hover:border-[var(--ff-text-tertiary)]'}`}>
        <span className="min-w-0 flex-1">
          <MiddleTruncate name={label} />
          {!outsideSelection && <span className="block text-xs font-normal text-[var(--ff-text-tertiary)]">{accountCount} accounts</span>}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
      </button>
      {open && (
        <div onMouseDown={e => e.preventDefault()} className="absolute left-0 top-full z-30 mt-1 w-[420px] max-w-[90vw] rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] shadow-xl">
          <div className="flex items-center gap-2 border-b border-[var(--ff-border-light)] px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-[var(--ff-text-tertiary)]" aria-hidden />
            <input ref={input} role="combobox" aria-expanded aria-controls={listId} aria-autocomplete="list" aria-label="Search accounts"
              aria-activedescendant={current ? `${uid}-${current.account.id}` : undefined} aria-keyshortcuts="Alt+P"
              value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onKeyDown}
              placeholder="Search name, number or code" data-testid="bank-switcher-search"
              className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--ff-text-tertiary)]" />
          </div>
          <ul id={listId} role="listbox" aria-label="Bank accounts" data-testid="bank-switcher-list" className="max-h-[360px] overflow-y-auto py-1">
            {rows.length === 0 && <li role="presentation" className="px-4 py-3 text-sm text-[var(--ff-text-secondary)]">No account matches</li>}
            {sections.map((sec) => {
              if (!sec.group) return renderOption(sec.items[0]!);
              const g = sec.group;
              return (
                <li key={g.key} role="group" aria-label={`${g.group.groupName}, ${g.group.accounts.length} sub-accounts`} data-testid="bank-switcher-group">
                  <div role="presentation"
                    className="mt-1 flex items-center justify-between gap-2 border-t border-[var(--ff-border-light)] px-3 pb-0.5 pt-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--ff-text-secondary)]">
                    <span className="min-w-0 flex-1 truncate">{g.group.groupName} · {g.group.accounts.length} sub-accounts</span>
                    <PinButton cardKey={g.key} name={`${g.group.groupName} group`} pinned={pinned.has(g.key)} onToggle={onTogglePin} />
                  </div>
                  <ul role="presentation" className="m-0 list-none p-0">{sec.items.map(renderOption)}</ul>
                </li>
              );
            })}
          </ul>
          <p className="border-t border-[var(--ff-border-light)] px-3 py-1.5 text-xs text-[var(--ff-text-tertiary)]">
            ↑↓ to move, Enter to open, Alt+P to pin or unpin the card
          </p>
        </div>
      )}
    </div>
  );
}
