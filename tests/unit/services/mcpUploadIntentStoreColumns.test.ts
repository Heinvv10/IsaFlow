/**
 * mcpUploadIntentStore: the token lookup (the PUT route's first read, before any body is accepted) names its columns
 * and never reads staged_bytes, so a lookup of an uploaded row does not pull up to 10 MB out of TOAST; the finalize
 * lock does not read them either (finalize reads bytes only for the items it will verify, within its per-call budget).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ text: [] as string[] }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => { seen.text.push(strings.join('$')); return []; }),
}));

import { findIntentByToken, lockIntentForFinalize } from '@/modules/accounting/services/core/mcpUploadIntentStore';

beforeEach(() => { seen.text = []; });

describe('mcpUploadIntentStore reads', () => {
  it('findIntentByToken selects explicit columns, never staged_bytes', async () => {
    await findIntentByToken('a'.repeat(43));
    expect(seen.text).toHaveLength(1);
    expect(seen.text[0]).not.toMatch(/staged_bytes/);
    expect(seen.text[0]).not.toMatch(/\.\*|SELECT \*/);
  });

  it('lockIntentForFinalize does not read staged_bytes', async () => {
    await lockIntentForFinalize('22222222-2222-2222-2222-222222222222', '99999999-9999-4999-8999-999999999999');
    expect(seen.text[0]).not.toMatch(/staged_bytes|\.\*/);
  });
});
