/**
 * THE wording of what a live run did to an owned item or category (round-12 structural rule), for the summary and the stop message alike.
 * PURE. Every "was / may have been / would be updated" and every "nothing written" comes from the LIVE tool answer of the batch that carried
 * the row:
 *   - the dry run's answer is read only, in the summary, to find a row's batch when that live batch has no answer (it rolled back); a stop
 *     never reads the dry run (round 22: an unconfirmed batch without a live answer says what it may have updated is not known);
 *   - "nothing written" only when the batch rolled back or the registry SAID it served a stored answer (`replayed`);
 *   - the books check after the COMMIT never turns a write into "nothing written": it only adds "then changed in the books since" to the
 *     rows it named (`changedRows`), and "another row of its batch changed since" to the others.
 */
import type { BatchReport, PhaseReport } from './sageMigrationTypes';

export const WAS_UPDATED = "was updated to Sage's values (an IsaFlow edit of these fields was overwritten)";
export const THEN_CHANGED = "was updated to Sage's values, then changed in the books since (check)";
export const SIBLING_CHANGED = "was updated to Sage's values (another row of its batch changed since: check)";
const WOULD = "would be updated to Sage's values";

/** The outcome a batch's answer gives the row (`updated`, `unchanged`, `created`), by item code or category name; undefined when it does not name it. */
export function outcomeOf(b: BatchReport, entity: 'category' | 'item', name: string): string | undefined {
  if (b.entity !== entity || b.toolReported === null) return undefined;
  if (entity === 'category') return b.toolReported.name === name ? String(b.toolReported.outcome) : undefined;
  const rows = Array.isArray(b.toolReported.rows) ? (b.toolReported.rows as Array<{ code?: unknown; outcome?: unknown }>) : [];
  const row = rows.find((x) => x.code === name);
  return row ? String(row.outcome) : undefined;
}

/** A row the live answer of a batch that RAN and committed says it updated: written, then changed (books check), or a sibling changed. */
export function writtenWording(b: BatchReport, name: string): string {
  if (b.changedRows?.includes(name)) return THEN_CHANGED;
  if (b.changedAfterCommit) return SIBLING_CHANGED;
  return WAS_UPDATED;
}

/** After a live run: what became of an owned row the dry run or the live run named as one Sage's values change. */
export function liveRowWording(live: PhaseReport, dry: PhaseReport, entity: 'category' | 'item', name: string): string {
  if (live.skipped) return `${WOULD} (not written: the ${entity === 'category' ? 'categories' : 'items'} phase did not run)`;
  // The live answer first; the dry run only to find the position of a live batch that has no answer.
  const carrier = live.batches.find((b) => outcomeOf(b, entity, name) !== undefined);
  const n = carrier?.n ?? dry.batches.find((b) => outcomeOf(b, entity, name) !== undefined)?.n;
  const b = carrier ?? live.batches.find((x) => x.n === n);
  // The fallback the types ask for (every live batch of a phase that ran is in it, and some answer named the row): never "was updated".
  if (!b) return "may have been updated to Sage's values (its batch is not in the report: check the books)";
  if (b.replayed) return `${WOULD} (not in the books: ${entity} batch ${b.n} was answered from a stored answer, nothing written)`;
  if (b.toolReported === null) return `${WOULD} (not in the books: ${entity} batch ${b.n} failed)`;
  const outcome = outcomeOf(b, entity, name);
  if (outcome !== 'updated') return `not updated by the live run (${entity} batch ${b.n} answered ${outcome ?? 'without it'} for it: check the books)`;
  return writtenWording(b, name);
}
