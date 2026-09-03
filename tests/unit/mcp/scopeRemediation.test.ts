// RED phase — written before src/lib/mcp/scopeRemediation.ts exists.
/**
 * What a caller is told when its token lacks a tool's scope.
 *
 * THE MESSAGE IS THE ENTIRE USER EXPERIENCE OF A NEW SCOPE. Every pilot
 * connector that exists today was granted before `write:contacts` did, so every
 * one of them hits this on its first `create_customer` call. A bare
 * "Insufficient scope: this tool requires write:contacts" tells the person
 * driving that agent nothing they can act on — and answering with the shared
 * NOT_FOUND would be worse, because it reads as a missing record.
 *
 * So a scope added after tokens were minted carries a remediation line saying
 * the connector must be re-authorised, and naming what the scope is FOR in
 * words the person granting it will recognise from the consent screen.
 */
import { describe, it, expect } from 'vitest';
import { insufficientScopeMessage, SCOPE_REMEDIATION } from '@/lib/mcp/scopeRemediation';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { PAT_SCOPES } from '@/lib/auth/patScopes';

describe('insufficientScopeMessage', () => {
  it('TELLS A write:contacts CALLER TO RE-AUTHORISE, in those terms', () => {
    const message = insufficientScopeMessage('write:contacts');
    expect(message).toMatch(/re-?authoris|re-?authoriz|reconnect/i);
    expect(message).toMatch(/contact/i);
    // Still names the scope, so an operator can match it to the grant screen.
    expect(message).toContain('write:contacts');
  });

  it('never answers a scope failure as a missing record', () => {
    for (const scope of PAT_SCOPES) {
      expect(insufficientScopeMessage(scope)).not.toBe('Not found');
      expect(insufficientScopeMessage(scope)).toMatch(/scope|permission/i);
    }
  });

  it('falls back to a usable message for a scope with no remediation entry', () => {
    const message = insufficientScopeMessage('read:reports');
    expect(message).toContain('read:reports');
    expect(message.length).toBeGreaterThan(20);
  });

  it('every remediation key is a REAL scope — a typo would never fire', () => {
    for (const scope of Object.keys(SCOPE_REMEDIATION)) {
      expect(PAT_SCOPES as readonly string[]).toContain(scope);
    }
  });

  it('every scope a registered tool requires is a real scope', () => {
    for (const tool of MCP_TOOLS) {
      if (tool.scope) expect(PAT_SCOPES as readonly string[]).toContain(tool.scope);
    }
  });
});
