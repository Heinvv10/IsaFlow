/**
 * MCP reconciliation benchmark.
 *
 * Usage: bun scripts/mcp-recon-benchmark.ts <companyId> <from> <to>
 *
 * Measures the acceptance criterion for the "agent does the work" slice:
 * of the bank allocations the agent posted in the window, what fraction were
 * subsequently reversed? Under 5% passes.
 *
 * A window with zero agent postings measures nothing, so it is reported and
 * exited as its own outcome (NOT MEASURED) rather than folded into PASS —
 * `total === 0` gives `rate === 0`, and a silent PASS on that is
 * indistinguishable from a genuinely clean month to anything that only
 * checks the exit code.
 *
 * Exit codes:
 *   0 = measured, correction rate < 5%  (PASS)
 *   1 = measured, correction rate >= 5% (FAIL)
 *   2 = usage error (missing arguments)
 *   3 = NOT MEASURED — zero agent postings in the window
 */
import { sql } from '@/lib/neon';
import { listAgentPostings } from '@/modules/accounting/services/bank/agentActivityService';

async function main(): Promise<number> {
  const [companyId, from, to] = process.argv.slice(2);
  if (!companyId || !from || !to) {
    process.stderr.write('Usage: bun scripts/mcp-recon-benchmark.ts <companyId> <from> <to>\n');
    return 2;
  }

  process.stdout.write(`company: ${companyId}\nwindow: ${from} to ${to}\n`);

  const postings = await listAgentPostings(companyId, from, to);
  const total = postings.length;

  if (total === 0) {
    process.stdout.write(
      'agent postings: 0\n' +
        'BENCHMARK NOT MEASURED — 0 agent postings in this window; nothing was evaluated\n',
    );
    return 3;
  }

  const reversedRows = (await sql`
    SELECT COUNT(*)::int AS n
    FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID
      AND je.posting_agent LIKE 'mcp:%'
      AND je.entry_date >= ${from}::DATE
      AND je.entry_date <= ${to}::DATE
      AND je.status = 'reversed'
  `) as { n: number }[];

  const reversed = reversedRows[0]?.n ?? 0;
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
