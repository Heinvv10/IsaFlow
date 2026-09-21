/**
 * K-051 — the preview must not log a mutation it did not perform.
 *
 * The MCP dry run builds the contra through the same `buildReversalLines` the
 * write uses, so that the preview cannot promise a tag the post would drop.
 * That made it emit the write-tense "Reversal dropped a dimension…" warn while
 * `wroteNothing: true` and no contra existed — an operator reading journalctl
 * could not tell a preview from a post.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// No dimension is owned: every SELECT comes back empty, so a tagged line drops.
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { log } from '@/lib/logger';
import { buildReversalLines } from '@/modules/accounting/services/gl/reversalLines';
import type { JournalLine } from '@/modules/accounting/types/gl.types';

const COMPANY = '11111111-1111-1111-1111-111111111111';
const FOREIGN_PROJECT = '22222222-2222-2222-2222-222222222222';

const taggedLine = () => ([{
  id: '33333333-3333-3333-3333-333333333333',
  journalEntryId: '44444444-4444-4444-4444-444444444444',
  glAccountId: '55555555-5555-5555-5555-555555555555',
  debit: 1000,
  credit: 0,
  description: 'tagged',
  projectId: FOREIGN_PROJECT,
}] as unknown as JournalLine[]);

const warnMessages = () => (log.warn as unknown as { mock: { calls: unknown[][] } })
  .mock.calls.map((c) => String(c[0]));

describe('buildReversalLines logging', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('says a dimension WOULD be dropped when it is only previewing', async () => {
    const built = await buildReversalLines(COMPANY, taggedLine(), { preview: true });

    expect(built.droppedLineCount).toBe(1);
    expect(built.lines[0]!.projectId).toBeUndefined();
    expect(warnMessages()).toEqual(['Reversal preview: a dimension that does not belong to this company would be dropped (nothing written)']);
  });

  it('says it DID drop one on the write path', async () => {
    await buildReversalLines(COMPANY, taggedLine());

    expect(warnMessages()).toEqual(['Reversal dropped a dimension that does not belong to this company']);
  });

  it('logs nothing when every dimension is owned or absent', async () => {
    const untagged = taggedLine().map((l) => ({ ...l, projectId: undefined }));
    const built = await buildReversalLines(COMPANY, untagged, { preview: true });

    expect(built.droppedLineCount).toBe(0);
    expect(warnMessages()).toEqual([]);
  });
});
