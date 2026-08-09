/**
 * MCP reconciliation benchmark.
 *
 * Usage: bun scripts/mcp-recon-benchmark.ts <companyId> <from> <to>
 *
 * Measures the acceptance criterion for the "agent does the work" slice:
 * of the bank allocations the agent posted in the window, what fraction were
 * subsequently reversed? Under 5% passes.
 */
import { sql } from '@/lib/neon';
import { listAgentPostings } from '@/modules/accounting/services/bank/agentActivityService';

async function main(): Promise<number> {
  const [companyId, from, to] = process.argv.slice(2);
  if (!companyId || !from || !to) {
    process.stderr.write('Usage: bun scripts/mcp-recon-benchmark.ts <companyId> <from> <to>\n');
    return 2;
  }

  const postings = await listAgentPostings(companyId, from, to);
  const reversedRows = (await sql`
    SELECT COUNT(*)::int AS n
    FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID
      AND je.posting_agent LIKE 'mcp:%'
      AND je.entry_date >= ${from}::DATE
      AND je.entry_date <= ${to}::DATE
      AND je.status = 'reversed'
  `) as { n: number }[];

  const total = postings.length;
  const reversed = reversedRows[0]?.n ?? 0;
  const rate = total === 0 ? 0 : (reversed / total) * 100;

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
