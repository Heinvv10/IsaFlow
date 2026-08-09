/**
 * MCP reconciliation benchmark.
 *
 * Usage: bun scripts/mcp-recon-benchmark.ts <companyId> <from> <to>
 *
 * Measures the acceptance criterion for the "agent does the work" slice:
 * of the bank allocations the agent posted in the window, what fraction were
 * subsequently reversed? Under 5% passes.
 *
 * Counting rules — all three exist because getting any of them wrong makes the
 * gate structurally unable to fail:
 *
 *  1. A correction is `reversed_at IS NOT NULL`, NOT `status = 'reversed'`.
 *     Reversal in this codebase posts a contra and records reversed_at while
 *     the original DELIBERATELY stays 'posted' (journalEntryPostingService) —
 *     flipping the status dropped the original out of posted-only reports
 *     while the contra stayed, driving accounts to the negative of the
 *     original. On the production database `status = 'reversed'` matches 0
 *     rows against 38 carrying reversed_at, so the old numerator was
 *     structurally always 0 and the harness always printed PASS.
 *
 *  2. Numerator and denominator are counted in ONE query over the SAME
 *     population, uncapped. Reading the denominator through
 *     listAgentPostings() applied its default LIMIT 50 while the numerator's
 *     COUNT(*) was unbounded, so any month with more than 50 agent postings
 *     compared two different populations.
 *
 *  3. Reversal contras are excluded from the denominator. They now carry
 *     mcp:reverse_bank_allocation:v1 themselves, so counting them would add a
 *     row to the denominator for every correction without adding one to the
 *     numerator — each real mistake would dilute the very rate meant to catch
 *     it.
 *
 * Exit codes:
 *   0 = measured, correction rate < 5%  (PASS)
 *   1 = measured, correction rate >= 5% (FAIL)
 *   2 = usage error (missing arguments)
 *   3 = NOT MEASURED — zero agent allocations in the window
 *
 * A window with zero agent postings measures nothing, so it is reported and
 * exited as its own outcome (NOT MEASURED) rather than folded into PASS —
 * `total === 0` gives `rate === 0`, and a silent PASS on that is
 * indistinguishable from a genuinely clean month to anything that only
 * checks the exit code.
 */
import { sql } from '@/lib/neon';

/** Correction rate at or above this fails the gate. */
export const CORRECTION_THRESHOLD_PCT = 5;

export interface BenchmarkCounts {
  /** Agent-originated postings in the window (denominator). */
  total: number;
  /** How many of THOSE SAME rows carry reversed_at (numerator). */
  reversed: number;
}

export interface BenchmarkDecision {
  measured: boolean;
  /** Correction rate as a percentage; null when nothing was measured. */
  rate: number | null;
  verdict: 'PASS' | 'FAIL' | 'NOT MEASURED';
  exitCode: 0 | 1 | 3;
}

/**
 * Counts numerator and denominator in ONE uncapped query over ONE population.
 * Exported so a test can read the SQL this actually runs — every one of the
 * three header bugs was a property of this query text, not of the arithmetic,
 * so a test against a re-typed copy would not have caught any of them.
 */
export async function fetchCounts(companyId: string, from: string, to: string): Promise<BenchmarkCounts> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE je.reversed_at IS NOT NULL)::int AS reversed
    FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID
      AND je.posting_agent LIKE 'mcp:%'
      AND je.reversal_of_id IS NULL
      AND je.entry_date >= ${from}::DATE
      AND je.entry_date <= ${to}::DATE
  `) as { total: number; reversed: number }[];

  return { total: rows[0]?.total ?? 0, reversed: rows[0]?.reversed ?? 0 };
}

/** Pure verdict + exit code. Zero postings is its own outcome, never a PASS. */
export function decide({ total, reversed }: BenchmarkCounts): BenchmarkDecision {
  if (total === 0) return { measured: false, rate: null, verdict: 'NOT MEASURED', exitCode: 3 };
  const rate = (reversed / total) * 100;
  return rate < CORRECTION_THRESHOLD_PCT
    ? { measured: true, rate, verdict: 'PASS', exitCode: 0 }
    : { measured: true, rate, verdict: 'FAIL', exitCode: 1 };
}

async function main(): Promise<number> {
  const [companyId, from, to] = process.argv.slice(2);
  if (!companyId || !from || !to) {
    process.stderr.write('Usage: bun scripts/mcp-recon-benchmark.ts <companyId> <from> <to>\n');
    return 2;
  }

  process.stdout.write(`company: ${companyId}\nwindow: ${from} to ${to}\n`);

  const counts = await fetchCounts(companyId, from, to);
  const decision = decide(counts);

  if (!decision.measured) {
    process.stdout.write(
      'agent postings: 0\n' +
        'BENCHMARK NOT MEASURED — 0 agent postings in this window; nothing was evaluated\n',
    );
    return decision.exitCode;
  }

  process.stdout.write(
    `agent postings: ${counts.total}\nreversed (corrections): ${counts.reversed}\n` +
      `correction rate: ${(decision.rate ?? 0).toFixed(2)}%\n`,
  );
  process.stdout.write(
    decision.verdict === 'PASS'
      ? `BENCHMARK PASS (<${CORRECTION_THRESHOLD_PCT}%)\n`
      : `BENCHMARK FAIL (>=${CORRECTION_THRESHOLD_PCT}%)\n`,
  );
  return decision.exitCode;
}

// Only run main when invoked directly, not when imported by tests — the CLI
// contract (argv in, stdout + exit code out) is unchanged.
// `import.meta.main` is a Bun extension; cast to avoid tsc complaints
// (mirrors scripts/apply-migrations.ts).
if ((import.meta as { main?: boolean }).main) {
  main().then((code) => { process.exitCode = code; }).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  });
}
