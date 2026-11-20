/**
 * #1656 (security review, sibling-path parity): Payroll is a module in User Access, so every way into payroll data asks
 * it. Every pages/api/payroll handler is wrapped in withPayrollModule (Payroll READ on GET/HEAD/OPTIONS, Payroll WRITE on
 * every other method), and every payroll MCP tool declares `permissionModule: 'payroll'`, which the registry's module
 * fence turns into the same read / write check before the handler runs.
 *
 * A new payroll route or tool without the wrapper fails here. Census over git ls-files (an untracked file is not seen).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';

const routes = execFileSync('git', ['ls-files', 'pages/api/payroll'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.ts$/.test(f));

/** The default export's expression, whitespace collapsed (the wrapper must be IN it, not merely imported). */
function defaultExport(source: string): string | null {
  const m = /export\s+default\s+([\s\S]*?);\s*$/m.exec(source);
  return m ? m[1]!.replace(/\s+/g, ' ') : null;
}

/** A payroll tool: payroll-scoped, or named for payroll data. */
const PAYROLL_NAME = /employee|pay_?run|payroll|payslip|irp5|emp201|emp501|\beti\b|_eti_|uif|leave_/;

describe('payroll module census (#1656)', () => {
  it('finds the payroll routes (the census is not empty)', () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  it('every pages/api/payroll handler is exported through withPayrollModule', () => {
    const missing = routes.filter((f) => {
      const exp = defaultExport(readFileSync(f, 'utf8'));
      return exp === null || !/\bwithPayrollModule\(/.test(exp);
    });
    expect(missing, `Wrap these in withPayrollModule (src/lib/auth/withPayrollModule.ts): ${missing.join(', ')}`).toEqual([]);
  });

  it('withPayrollModule sits inside withAuth (it reads the company and user withAuth set)', () => {
    const outside = routes.filter((f) => {
      const exp = defaultExport(readFileSync(f, 'utf8')) ?? '';
      return !/^withAuth\(withPayrollModule\(/.test(exp);
    });
    expect(outside).toEqual([]);
  });

  it('every payroll MCP tool declares permissionModule payroll', () => {
    const payrollTools = MCP_TOOLS.filter((t) =>
      t.scope === 'read:payroll' || t.scope === 'write:payroll' || PAYROLL_NAME.test(t.name));
    expect(payrollTools.length).toBeGreaterThan(10);
    const missing = payrollTools.filter((t) => t.permissionModule !== 'payroll').map((t) => t.name);
    expect(missing, `Add permissionModule: 'payroll' to: ${missing.join(', ')}`).toEqual([]);
  });

  it('no tool outside payroll claims the payroll module', () => {
    const stray = MCP_TOOLS.filter((t) => t.permissionModule === 'payroll'
      && !(t.scope === 'read:payroll' || t.scope === 'write:payroll' || PAYROLL_NAME.test(t.name))).map((t) => t.name);
    expect(stray).toEqual([]);
  });
});
