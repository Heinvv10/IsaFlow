import { expect, it } from 'vitest';
import { beginMcpInvocation, completeMcpInvocation } from '@/lib/mcp/invocationStore';
it('refuses admission outside an active authenticated request', async () => {
  await expect(beginMcpInvocation({ tool: 'synthetic_tool', argsHash: 'a'.repeat(64), idempotencyKeyHash: null })).rejects.toThrow(/control transaction/i);
});
it('refuses fabricated completion capabilities', async () => {
  await expect(completeMcpInvocation({ attemptId: 'synthetic' } as never,
    { status: 'ok', reportedWrite: true, durationMs: 1 })).rejects.toThrow();
});
