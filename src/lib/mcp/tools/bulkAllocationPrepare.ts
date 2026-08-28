/**
 * Pre-write preparation for `bulk_allocate_bank_transactions`.
 *
 * Everything here is READ-ONLY: parse, tenant-ownership check, reference
 * resolution, de-duplication. It is split out of the tool because the split IS
 * the safety boundary — a fault found in here is refused with a precise
 * toolError (nothing was written, so there is nothing to roll back), while any
 * fault after it must THROW so the registry's savepoint unwinds the batch.
 */
import type { McpToolContext } from '../types';
import {
  type AllocationLine,
  checkLinesOwnership,
  parseAllocationLine,
  resolveTxSelectors,
} from './allocationLine';

// Each line posts a journal inside one request transaction, so the batch size
// bounds how long a single connection holds its locks. 500 matches the PRD and
// keeps the response (one id pair per line) well inside the transport's 1mb cap.
export const MAX_LINES = 500;

export interface ResolvedLine {
  /**
   * Index into the caller's own `allocations` array — carried, not recomputed.
   * Every downstream report (skips, per-line failures) names the line the AGENT
   * sent, and the batch is re-ordered by transaction id before posting, so a
   * position in any later array means nothing to the caller.
   */
  index: number;
  txId: string;
  line: AllocationLine;
}

/**
 * Every line error in one reply, not just the first.
 *
 * Stopping at the first fault turns a 500-line batch with three typos into
 * three round trips, and each retry re-resolves every reference. The agent can
 * fix all of them at once, so it should be told all of them at once. Capped so
 * a wholly malformed batch cannot answer with 500 lines of prose.
 */
const MAX_REPORTED_ERRORS = 20;

function joinErrors(errors: string[]): string {
  const shown = errors.slice(0, MAX_REPORTED_ERRORS);
  const more = errors.length - shown.length;
  return shown.join(' | ') + (more > 0 ? ` | …and ${more} more` : '');
}

/** Parses, ownership-checks, resolves and de-duplicates. All reads — no writes. */
export async function prepareAllocationLines(
  args: Record<string, unknown>,
  ctx: McpToolContext,
): Promise<ResolvedLine[] | string> {
  const raw = args.allocations;
  if (!Array.isArray(raw) || raw.length === 0) {
    return 'allocations must be a non-empty array';
  }
  // Checked BEFORE anything queries: a 5,000-line call must cost one refusal,
  // not 5,000 rows of reference resolution.
  if (raw.length > MAX_LINES) {
    return `allocations holds ${raw.length} lines — at most ${MAX_LINES} per call. Split the batch.`;
  }

  const lines: AllocationLine[] = [];
  const errors: string[] = [];
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`allocations[${i}] must be an object`);
      continue;
    }
    const parsed = parseAllocationLine(entry as Record<string, unknown>);
    // The index matters: an agent holding 500 lines cannot act on "alloc_type
    // must be one of…" without being told which line it belongs to.
    if (typeof parsed === 'string') {
      errors.push(`allocations[${i}]: ${parsed}`);
      continue;
    }
    lines.push(parsed);
  }
  // Parse errors short-circuit the queries below deliberately: a line that did
  // not parse has no ids to own-check, and reporting resolution failures for
  // the lines that DID parse alongside them just buries the real faults.
  if (errors.length > 0) return joinErrors(errors);

  const ownership = await checkLinesOwnership(ctx.companyId, lines);
  // One answer for the whole batch, and deliberately not per-line: naming which
  // line held the foreign id is the existence oracle the shared NOT_FOUND
  // exists to avoid.
  if (ownership) return ownership;

  // ONE lookup for the whole batch (per distinct bank-account scope), not one
  // per line. Each line's row lock is held to the end of the request, so 500
  // sequential lookups added their latency directly to the time the batch keeps
  // every other writer waiting — ~3 ms each against a full company scan before
  // migration 519's expression indexes.
  const resolutions = await resolveTxSelectors(lines.map((l) => l.selector), ctx.companyId);

  const resolved: ResolvedLine[] = [];
  const seen = new Map<string, number>();
  for (const [i, line] of lines.entries()) {
    const r = resolutions[i]!;
    if ('error' in r) {
      errors.push(`allocations[${i}]: ${r.error}`);
      continue;
    }
    // De-duplicated AFTER resolution, so two lines naming the same row by
    // different routes (a UUID and its bank_reference) are caught too. Left
    // through, the second line hits "Transaction already allocated" mid-write
    // and rolls back the other 499 — a refusal the agent can only fix by
    // re-sending, and a batch it cannot tell apart from a database failure.
    const prior = seen.get(r.id);
    if (prior !== undefined) {
      errors.push(
        `allocations[${i}] names transaction ${r.id}, already allocated by allocations[${prior}] in this call.`,
      );
      continue;
    }
    seen.set(r.id, i);
    resolved.push({ index: i, txId: r.id, line });
  }
  if (errors.length > 0) return joinErrors(errors);
  return resolved;
}
