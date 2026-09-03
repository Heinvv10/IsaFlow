import { describe, expect, it } from 'vitest';
import {
  SYSTEM_USER_ID,
  actorForHuman,
  actorForMcp,
  actorForSystem,
  isActorType,
} from '@/lib/mcp/contracts/actor';
import type { McpToolContext } from '@/lib/mcp/types';

const CTX: McpToolContext = {
  userId: 'user-1',
  companyId: 'company-1',
  scopes: ['write:post'],
  tokenJti: 'pat-42',
  oauthAppId: null,
};

describe('actor identity', () => {
  it('records an MCP write as an agent, and keeps the granting user', () => {
    const actor = actorForMcp(CTX, 'mcp:apply_receipt_to_invoice:v1');
    expect(actor.actorType).toBe('agent');
    expect(actor.userId).toBe('user-1');
    expect(actor.tokenJti).toBe('pat-42');
    expect(actor.postingAgent).toBe('mcp:apply_receipt_to_invoice:v1');
  });

  it('never labels an MCP write as human, even from a self-minted PAT', () => {
    expect(actorForMcp(CTX, 'mcp:x:v1').actorType).not.toBe('human');
  });

  it('records a UI write as human with no token', () => {
    const actor = actorForHuman('user-9');
    expect(actor.actorType).toBe('human');
    expect(actor.tokenJti).toBeNull();
    expect(actor.postingAgent).toBe('human:user-9');
  });

  it('attributes a system write to no person', () => {
    const actor = actorForSystem('year_end_close');
    expect(actor.actorType).toBe('system');
    expect(actor.userId).toBe(SYSTEM_USER_ID);
    expect(actor.postingAgent).toBe('system:year_end_close');
  });

  it('validates actor types', () => {
    expect(isActorType('agent')).toBe(true);
    expect(isActorType('robot')).toBe(false);
  });
});
