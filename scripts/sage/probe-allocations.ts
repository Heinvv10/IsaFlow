/**
 * Read-only, shape-only probe: does Sage expose which invoice a receipt or
 * supplier payment paid? Run by a human, against ONE Sage company (whichever
 * company the session cookie is signed in to). Prints key names, nesting,
 * array lengths and HTTP status only — never a value, name, amount or id.
 *
 * Usage (never put the cookie on the command line — it would land in shell history):
 *   bun run scripts/sage/probe-allocations.ts --dry-run
 *   read -rs SAGE_COOKIE && export SAGE_COOKIE && bun run scripts/sage/probe-allocations.ts; unset SAGE_COOKIE
 * Optional: --base https://accounting.sageone.co.za (must be a Sage HTTPS host).
 */
import { checkPublicUrl, safeFetch } from '@/lib/safeFetch';
import { SAGE_ALLOWED_HOSTS } from '@/modules/admin/services/sageSession';
import { parseProbeArgs, runAllocationProbe } from '@/modules/admin/services/sageAllocationProbe';

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

async function main() {
  let parsed: ReturnType<typeof parseProbeArgs>;
  try { parsed = parseProbeArgs(process.argv.slice(2)); } catch (error) { fail(error instanceof Error ? error.message : 'Invalid arguments'); }
  const { dryRun, base } = parsed;
  const baseReason = await checkPublicUrl(base, { allowHosts: SAGE_ALLOWED_HOSTS });
  if (baseReason) fail(`--base must be a Sage HTTPS host (${baseReason})`);
  const cookie = process.env.SAGE_COOKIE ?? '';
  if (!dryRun && cookie.length < 16) fail('SAGE_COOKIE is missing or too short');

  const result = await runAllocationProbe({
    base, cookie, dryRun,
    fetch: (url, init) => safeFetch(url, init, { allowHosts: SAGE_ALLOWED_HOSTS, timeoutMs: 20000 }),
    write: line => process.stdout.write(`${line}\n`),
  });
  process.stdout.write(`${JSON.stringify({ done: true, requestsMade: result.requests })}\n`);
}

main().catch(error => fail(`Probe failed: ${error instanceof Error ? error.name : 'unknown error'}`));
