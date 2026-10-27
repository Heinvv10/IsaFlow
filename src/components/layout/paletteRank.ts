/**
 * Ranking and sectioning for the command palette. Pure: the page index and the server's record hits come
 * in, ordered sections go out, and every row that is a page carries the trail that leads to it.
 */
import type { NavIndexEntry } from '@/components/accounting/navSections/navIndex';
import { trailForPath } from '@/components/accounting/navSections/navIndex';
import { filterActions, PALETTE_ACTIONS, type PaletteAction } from './commandActions';

export interface SearchResult {
  type: string;
  id: string;
  title: string;
  subtitle: string;
  url: string;
  icon: string;
  /** Ancestors of a page, root first. Absent on records. */
  trail?: string[];
}

export type PaletteRow =
  | { key: string; kind: 'action'; action: PaletteAction }
  | { key: string; kind: 'item'; item: SearchResult };

export interface PaletteSection {
  id: 'recent' | 'actions' | 'pages' | 'records';
  heading: string;
  rows: PaletteRow[];
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** "tb" is the initials of "Trial Balance", "pl" of "Profit & Loss": people type the short form they say aloud. */
function isInitials(q: string, label: string): boolean {
  const initials = label.split(' ').filter((w) => /^[a-z0-9]/.test(w)).map((w) => w[0]).join('');
  return initials.startsWith(q);
}

function scoreEntry(e: NavIndexEntry, q: string): number {
  const label = norm(e.label);
  if (label === q) return 5;
  if (label.startsWith(q)) return 4;
  if (label.split(' ').some((w) => w.startsWith(q))) return 3;
  if (label.includes(q)) return 2.5;
  if (e.trail.some((t) => norm(t).includes(q))) return 2;
  if (q.length >= 2 && isInitials(q, label)) return 1;
  return 0;
}

/** Pages whose label, trail or initials match. Ties: the shorter label, then fewer ancestors, then alphabetical. */
export function rankPages(index: NavIndexEntry[], query: string, limit: number): NavIndexEntry[] {
  const q = norm(query);
  if (!q || limit < 1) return [];
  return index
    .map((e) => ({ e, score: scoreEntry(e, q) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.e.label.length - b.e.label.length
      || a.e.trail.length - b.e.trail.length || a.e.label.localeCompare(b.e.label))
    .slice(0, limit)
    .map((s) => s.e);
}

export function pageResult(e: NavIndexEntry): SearchResult {
  return { type: 'page', id: e.href, title: e.label, subtitle: '', url: e.href, icon: 'arrow-right', trail: e.trail };
}

/** A server page hit (from PAGE_REGISTRY) gets the trail of the nav entry that owns its URL, if any. */
function withTrail(r: SearchResult, index: NavIndexEntry[]): SearchResult {
  if (r.type !== 'page' || r.trail) return r;
  const owner = trailForPath(r.url, index);
  return owner && owner.href === r.url ? { ...r, trail: owner.trail } : r;
}

const itemRow = (prefix: string, item: SearchResult): PaletteRow => ({ key: `${prefix}-${item.type}-${item.url}`, kind: 'item', item });

/** First 6 daily-link pages of the nav, for the empty query. */
function suggestedPages(index: NavIndexEntry[]): NavIndexEntry[] {
  return index.filter((e) => e.trail.length === 1 && !e.isSetting).slice(0, 6);
}

export interface BuildArgs {
  query: string;
  index: NavIndexEntry[];
  recent: SearchResult[];
  /** Server hits: records, plus page hits that the nav does not list. */
  server: SearchResult[];
}

export function buildSections({ query, index, recent, server }: BuildArgs): PaletteSection[] {
  const q = query.trim();
  const seen = new Set<string>();
  const take = (rows: PaletteRow[]): PaletteRow[] => rows.filter((r) => {
    const url = r.kind === 'item' ? r.item.url : (r.action.url ?? r.action.id);
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
  const actionRows = (list: readonly PaletteAction[]): PaletteRow[] =>
    list.map((action) => ({ key: `action-${action.id}`, kind: 'action' as const, action }));
  const sections: PaletteSection[] = [];

  if (!q) {
    const recents = take(recent.slice(0, 5).map((r) => itemRow('recent', withTrail(r, index))));
    sections.push({ id: 'recent', heading: 'Recent', rows: recents });
    sections.push({ id: 'actions', heading: 'Actions', rows: take(actionRows(PALETTE_ACTIONS)) });
    sections.push({ id: 'pages', heading: 'Pages', rows: take(suggestedPages(index).map((e) => itemRow('page', pageResult(e)))) });
  } else {
    sections.push({ id: 'actions', heading: 'Actions', rows: take(actionRows(filterActions(q))) });
    const pages = rankPages(index, q, 6).map(pageResult);
    const serverPages = server.filter((r) => r.type === 'page').map((r) => withTrail(r, index));
    sections.push({ id: 'pages', heading: 'Pages', rows: take([...pages, ...serverPages].slice(0, 8).map((p) => itemRow('page', p))) });
    sections.push({ id: 'records', heading: 'Records', rows: take(server.filter((r) => r.type !== 'page').map((r) => itemRow('record', r))) });
  }
  return sections.filter((s) => s.rows.length > 0);
}
