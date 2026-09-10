/**
 * A tool that CAN carry an approval (execute_bank_operation) and is given one
 * it cannot use gets an actionable refusal, not the generic failure — while a
 * stored-approval integrity failure stays generic, because it is not the
 * caller's mistake and its message must not be echoed back.
 */
import { describe, expect, it } from 'vitest';
import { GENERIC_FAILURE, handlerErrorReply } from '@/lib/mcp/handlerErrorReply';
import { SuppliedApprovalRefusal } from '@/modules/accounting/services/controls/suppliedApprovalRefusal';

const tool = { name: 'execute_bank_operation', inputSchema: { type: 'object', properties: {} } };
const text = (result: { content: Array<{ text: string }> }) => result.content.map((item) => item.text).join('\n');

describe('handlerErrorReply', () => {
  it('answers an unusable supplied approval with what is wrong with it', () => {
    const reply = handlerErrorReply(tool, new SuppliedApprovalRefusal('Approval material changed'));
    expect(reply.isError).toBe(true);
    expect(text(reply)).not.toBe(GENERIC_FAILURE);
    expect(text(reply)).toMatch(/Approval material changed/);
    expect(text(reply)).toMatch(/approval/i);
  });
  it('keeps an unexplained failure generic', () => {
    expect(text(handlerErrorReply(tool, new Error('Approval material is invalid')))).toBe(GENERIC_FAILURE);
  });
});
