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

async function main(): Promise<number> {
  const [companyId, from, to] = process.argv.slice(2);
  if (!companyId || !from || !to) {
    process.stderr.write('Usage: bun scripts/mcp-recon-benchmark.ts <companyId> <from> <to>\n');
    return 2;
  }

  process.stdout.write(`company: ${companyId}\nwindow: ${from} to ${to}\n`);

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

  const total = rows[0]?.total ?? 0;
  const reversed = rows[0]?.reversed ?? 0;

  if (total === 0) {
    process.stdout.write(
      'agent postings: 0\n' +
        'BENCHMARK NOT MEASURED — 0 agent postings in this window; nothing was evaluated\n',
    );
    return 3;
  }

  const rate = (reversed / total) * 100;

  process.stdout.write(
    `agent postings: ${total}\nreversed (corrections): ${reversed}\ncorrection rate: ${rate.toFixed(2)}%\n`,
  );
  process.stdout.write(rate < 5 ? 'BENCHMARK PASS (<5%)\n' : 'BENCHMARK FAIL (>=5%)\n');
  return rate < 5 ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
