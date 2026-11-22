/**
 * #1656 round 5: every WRITE path to a bank rule that can make or keep it auto-posting asks Banking Approve. A caller of the bank-rule
 * service's createRule / updateRule / toggleRule (outside the service and the tests) must carry the approval guard (autoPostApprovalGuard
 * / bankRuleApprovalFor: decided under the rule lock from the rule as it stands) or, for a creation, the early route gate. A new
 * path (a route, an MCP tool, a job) that writes rules without either fails here.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

const files = execFileSync('git', ['ls-files', 'pages', 'src'], { encoding: 'utf8' }).split('\n').filter((f) => /\.tsx?$/.test(f));
const IMPORTS_RULE_WRITES = /import\s*\{[^}]*\b(createRule|updateRule|toggleRule)\b[^}]*\}\s*from\s*'[^']*\/bank\/bankRulesService'/;
const writers = files.filter((f) => !f.startsWith('src/modules/accounting/services/bank/') && IMPORTS_RULE_WRITES.test(readFileSync(f, 'utf8')));

describe('bank rule write paths', () => {
  it('finds the three known writers (the census is not empty)', () => {
    expect(writers.sort()).toEqual(['pages/api/accounting/bank-rules-action.ts', 'pages/api/accounting/bank-rules.ts', 'src/lib/mcp/tools/writeBankRules.ts']);
  });

  it('every writer carries the approval guard, or (a creation route) the early Banking Approve gate', () => {
    const unguarded = writers.filter((f) => {
      const text = readFileSync(f, 'utf8');
      return !(/autoPostApprovalGuard\(|bankRuleApprovalFor\(/.test(text) || /refuseWithoutApprove\([^)]*'banking'[^)]*auto-posting bank rules/.test(text));
    });
    expect(unguarded, 'Pass autoPostApprovalGuard(mayApprove(banking)) as the rule write guard').toEqual([]);
  });

  it('the update and toggle routes and the MCP tools pass the guard to the service call itself', () => {
    const action = readFileSync('pages/api/accounting/bank-rules-action.ts', 'utf8');
    expect(action).toMatch(/updateRule\(companyId, body\.id, updateInput, userId, guard\)/);
    expect(action).toMatch(/toggleRule\(companyId, body\.id, body\.isActive !== false, userId, guard\)/);
    const mcp = readFileSync('src/lib/mcp/tools/writeBankRules.ts', 'utf8');
    expect((mcp.match(/approval\.guard/g) ?? []).length).toBe(3); // create, update, disable
  });
});
