/**
 * sagePagedPull.ts
 *
 * Reads every page of one Sage `GetWithFilter` list (#1655). The pull used to
 * ask for 200 rows a page, stop as soon as a page held fewer than 200, and move
 * `Skip` on by 200 whatever came back. Sage's own API serves at most 100 rows a
 * page (packages/sage-readonly-mcp/src/endpoints.ts), so a server that returns
 * fewer rows than asked lost everything after the first page — 102 suppliers
 * came across as 100 — and the count shown to the operator was the count
 * received, so nothing looked short.
 *
 * Now `Skip` advances by the rows actually received, paging goes on until Sage's
 * `TotalResults` is reached (or an empty page when Sage sends no total), and a
 * pull that ends short of the total Sage reported is refused rather than handed
 * to the commit as if it were complete. So is a page that starts with the same
 * ID as the page before it (a Sage that ignores Skip).
 */

export const SAGE_PULL_PAGE_SIZE = 200;
/** A bound on the loop if Sage ignores Skip and never sends an empty page. */
export const SAGE_PULL_MAX_PAGES = 1000;

export interface SagePage { Results?: unknown[]; TotalResults?: number }
export type FetchSagePage = (skip: number, take: number) => Promise<SagePage>;

export class SageIncompletePullError extends Error {}

function rowId(row: unknown): unknown {
  return row && typeof row === 'object' ? (row as { ID?: unknown }).ID : undefined;
}

export async function pullAllSagePages(
  label: string, fetchPage: FetchSagePage, pageSize = SAGE_PULL_PAGE_SIZE,
): Promise<{ results: unknown[]; total: number }> {
  const results: unknown[] = [];
  let reported: number | null = null;
  let previousFirstId: unknown;
  for (let page = 0; ; page++) {
    if (page >= SAGE_PULL_MAX_PAGES) {
      throw new SageIncompletePullError(`${label}: still not finished after ${SAGE_PULL_MAX_PAGES} pages; refusing a partial pull`);
    }
    const json = await fetchPage(results.length, pageSize);
    const rows = Array.isArray(json.Results) ? json.Results : [];
    // A Sage that ignores Skip sends page one again: refuse it rather than count the repeat as new rows.
    const firstId = rowId(rows[0]);
    if (page > 0 && firstId !== undefined && firstId === previousFirstId) {
      throw new SageIncompletePullError(`${label}: Sage sent the same page twice (Skip ignored); refusing a partial pull, nothing was imported`);
    }
    previousFirstId = firstId;
    if (typeof json.TotalResults === 'number' && Number.isFinite(json.TotalResults)) reported = json.TotalResults;
    results.push(...rows);
    if (rows.length === 0) break;
    if (reported !== null && results.length >= reported) break;
  }
  if (reported !== null && results.length < reported) {
    throw new SageIncompletePullError(
      `${label}: Sage reported ${reported} records but returned ${results.length}; refusing a partial pull, nothing was imported`,
    );
  }
  return { results, total: results.length };
}
