/**
 * S-07e: a Flows debit commits on its own migration_admin transaction, and its
 * refund for a request that then rolls back is queued with runAfterRollback.
 * Only withAuth and the bearer pipeline keep that queue (another owner drops the
 * work with a warning), so every metered entry point must run under one of them:
 *   - every route that meters (withFlowMeter, or a direct deductFlows) is withAuth's;
 *   - the MCP registry (debitForTool) is reached only through withBearerAuth.
 * A metered route added behind another wrapper turns this red.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..', '..', '..');
const grep = (pattern: string, ...dirs: string[]): string[] => {
  try {
    return execFileSync('git', ['grep', '-l', '-E', pattern, '--', ...dirs], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch {
    return []; // git grep exits 1 when nothing matches
  }
};

describe('metered entry points run under an owner that refunds on rollback', () => {
  it('every metering route is wrapped in withAuth, and in no owner without the queue', () => {
    const routes = grep('withFlowMeter\\(|deductFlows\\(', 'pages');
    expect(routes.length).toBeGreaterThan(5);
    const offenders = routes.filter((f) => {
      const src = readFileSync(resolve(ROOT, f), 'utf8');
      return !/\bwithAuth\(/.test(src) || /\bwith(PlatformAdmin|Admin|ExtensionToken|InviteToken|PublicRouteTransaction)\(/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it('the MCP tools that debit are served only by the bearer route', () => {
    expect(grep('debitForTool\\(', 'src', 'pages').sort()).toEqual(['src/lib/mcp/flowMetering.ts', 'src/lib/mcp/registry.ts']);
    // The registry is served through the tool index; every route that imports either must be bearer-only.
    const servers = grep('from [\'"]@/lib/mcp/(registry|toolIndex)[\'"]', 'pages');
    expect(servers.length).toBeGreaterThan(0);
    for (const f of servers) expect(readFileSync(resolve(ROOT, f), 'utf8'), f).toMatch(/\bwithBearerAuth\(/);
  });
});
