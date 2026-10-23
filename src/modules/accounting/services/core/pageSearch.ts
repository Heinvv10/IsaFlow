/**
 * Page matches for the top-bar search (global-search). The record search only
 * looks in the company's data, so a person typing "sage" or "import" found
 * nothing at all — the import pages existed but could not be searched for.
 *
 * Pure: matches the query against PAGE_REGISTRY titles, descriptions and
 * keywords. A title match ranks above a description or keyword match.
 */
import { PAGE_REGISTRY } from '@/modules/accounting/constants/pageRegistry';
import type { SearchResult } from './globalSearchService';

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function searchPages(query: string, limit: number): SearchResult[] {
  const q = norm(query);
  if (!q || limit < 1) return [];
  const scored: { score: number; result: SearchResult }[] = [];
  for (const page of Object.values(PAGE_REGISTRY)) {
    const title = norm(page.title);
    const words = [norm(page.description), ...(page.keywords ?? []).map(norm)];
    let score = 0;
    if (title === q) score = 4;
    else if (title.startsWith(q)) score = 3;
    else if (title.includes(q)) score = 2;
    else if (words.some((w) => w.includes(q))) score = 1;
    if (score === 0) continue;
    scored.push({
      score,
      result: { type: 'page', id: page.path, title: page.title, subtitle: page.description, url: page.path, icon: 'arrow-right' },
    });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.result.title.localeCompare(b.result.title))
    .slice(0, limit)
    .map((s) => s.result);
}
