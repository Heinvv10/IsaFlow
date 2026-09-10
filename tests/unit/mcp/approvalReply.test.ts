import { describe, expect, it } from 'vitest';
import { approvalRequiredReply } from '@/lib/mcp/approvalReply';
const tool = (name: string, properties: Record<string, unknown> = {}) => ({ name, inputSchema: { type: 'object', properties } });
describe('approvalRequiredReply', () => {
  it('never tells a tool that cannot carry an approval to retry with one', () => {
    for (const name of ['settle_by_contra', 'close_fiscal_period', 'approve_pay_run', 'bulk_allocate_bank_transactions']) {
      const reply = approvalRequiredReply(tool(name));
      expect(reply, name).toMatch(/cannot carry/i);
      expect(reply, name).not.toMatch(/then retry/i);
    }
  });
  it('names the app route where one is verified', () => {
    expect(approvalRequiredReply(tool('year_end_close'))).toMatch(/year-end close in the IsaFlow app/i);
    expect(approvalRequiredReply(tool('bulk_approve_supplier_invoices'))).toMatch(/IsaFlow app/i);
  });
  it('tells a tool that takes approval_id how to use it', () => {
    const reply = approvalRequiredReply(tool('void_payment', { approval_id: { type: 'string' } }));
    expect(reply).toMatch(/request_operation_approval/);
    expect(reply).toMatch(/approval_id/);
  });
});
