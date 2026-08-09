import { describe, it, expect } from 'vitest';
import { mcpPostingAgent } from '@/lib/mcp/postingAgent';

describe('mcpPostingAgent', () => {
  it('namespaces the tool so agent work is filterable against human:/legacy: entries', () => {
    expect(mcpPostingAgent('allocate_bank_transaction')).toBe('mcp:allocate_bank_transaction:v1');
  });

  it('is prefixed mcp: so a LIKE mcp:% review query finds every agent posting', () => {
    for (const t of ['allocate_bank_transaction', 'split_allocate_bank_transaction']) {
      expect(mcpPostingAgent(t).startsWith('mcp:')).toBe(true);
    }
  });
});
