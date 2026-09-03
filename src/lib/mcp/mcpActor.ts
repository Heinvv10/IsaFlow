/**
 * The actor an MCP write records, in the shape the posting services take.
 *
 * One actor model, defined in contracts/actor.ts; this only adapts it to the
 * `PostingActorOpts` every stamping service already accepts, so a tool never
 * assembles the fields by hand and cannot get the actor_type wrong.
 *
 * Everything comes from ctx. No tool argument may influence who a posting is
 * attributed to — that is the same rule that keeps companyId out of tool args.
 */
import type { McpToolContext } from './types';
import { actorForMcp } from './contracts/actor';
import { mcpPostingAgent } from './postingAgent';
import type { PostingActorOpts } from '@/modules/accounting/services/gl/journalEntryMeta';

/** An MCP write always has a stamp, so postingAgent is required here — which
 *  also makes the result assignable to JournalEntryMeta directly. */
export type McpPostingOpts = PostingActorOpts & { postingAgent: string };

export function mcpPostingOpts(ctx: McpToolContext, toolName: string): McpPostingOpts {
  const actor = actorForMcp(ctx, mcpPostingAgent(toolName));
  return {
    postingAgent: actor.postingAgent,
    actorType: actor.actorType,
    actorTokenJti: actor.tokenJti,
  };
}
