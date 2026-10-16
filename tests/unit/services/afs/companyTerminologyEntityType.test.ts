// getCompanyTerminology reads companies.entity_type, which holds an SA entity
// code since migration 894, and maps it to the AFS template: pty_ltd/ltd/npc ->
// company wording, cc -> close corporation, trust -> trust, anything else (and
// no row) -> the company fallback AFS always used.
import { describe, expect, it, vi } from 'vitest';

const sql = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql }));
import { getCompanyTerminology } from '@/modules/accounting/services/afs/entityTerminology';

describe('getCompanyTerminology: SA entity code -> AFS terminology', () => {
  it.each([
    ['pty_ltd', 'pty', 'directors'], ['ltd', 'pty', 'directors'], ['npc', 'pty', 'directors'],
    ['cc', 'cc', 'members'], ['trust', 'trust', 'trustees'],
    ['sole_proprietor', 'pty', 'directors'], ['partnership', 'pty', 'directors'], ['other', 'pty', 'directors'],
  ])('%s -> %s (%s)', async (code, template, leadership) => {
    sql.mockResolvedValueOnce([{ entity_type: code }]);
    const t = await getCompanyTerminology('c1');
    expect(t.entityType).toBe(template);
    expect(t.leadership).toBe(leadership);
  });

  it('no company row falls back to the company wording', async () => {
    sql.mockResolvedValueOnce([]);
    expect((await getCompanyTerminology('missing')).entityType).toBe('pty');
  });
});
