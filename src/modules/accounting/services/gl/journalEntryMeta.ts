/**
 * Journal Entry Meta — PRD-05 Phase 2
 * Posting-agent stamping helpers for every JE write path.
 */

export interface JournalEntryMeta {
  /** Identity of the agent/system that created this entry.
   *  Format: 'human' | 'human:<userId>' | 'ai:<pipeline>:v1'
   *          | 'rule:<ruleId>' | 'import:<source>' | 'system:<job>'
   */
  postingAgent: string;
  /** captured_documents.id — the original source document, if any. */
  sourceDocumentId?: string | null;
  /** SHA-256 hex of the original file bytes (set by VLM pipeline). */
  sourceDocumentHash?: string | null;
  /** 0..1 confidence score from the VLM extraction step. */
  extractionConfidence?: number | null;
}

export function defaultHumanMeta(userId?: string): JournalEntryMeta {
  return { postingAgent: userId ? `human:${userId}` : 'human' };
}
