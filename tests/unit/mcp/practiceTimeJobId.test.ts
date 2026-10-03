/**
 * An agent can only pass log_time_entry a job_id it can discover: list_time_entries
 * returns each entry's job_id, and log_time_entry's description says where the
 * id comes from. (No separate list-jobs tool.)
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/modules/accounting/services/practice/practiceTimeEntryService', () => ({
  listPracticeEntries: vi.fn(),
}));

import { listPracticeEntries } from '@/modules/accounting/services/practice/practiceTimeEntryService';
import { listTimeEntriesTool } from '@/lib/mcp/tools/practice';
import { logTimeEntryTool } from '@/lib/mcp/tools/writePracticeTime';
import type { McpToolContext } from '@/lib/mcp/types';

const JOB = '88888888-8888-4888-8888-888888888888';
const ctx: McpToolContext = {
  userId: '11111111-1111-4111-8111-111111111111', companyId: '22222222-2222-4222-8222-222222222222',
  scopes: ['read:practice'], tokenJti: 'j', oauthAppId: null,
};
const entry = (jobId: string | null) => ({
  id: 'e', companyId: ctx.companyId, userId: ctx.userId, entryDate: '2026-09-01', hours: 2,
  practiceClientId: 'c', jobCategoryId: 'k', workItemId: 'w', taskDescription: 'VAT201', notes: null, billable: true,
  appliedRate: 850, lineTotal: 1700, origin: 'assisted' as const, status: 'draft' as const, approvedBy: null,
  approvedAt: null, billedAt: null, invoiceId: null, jobId, writeOffReason: null, writtenOffBy: null, writtenOffAt: null,
  createdAt: '', updatedAt: '',
});

describe('MCP job ids', () => {
  it('list_time_entries returns each entry\'s job_id (null when it has none)', async () => {
    vi.mocked(listPracticeEntries).mockResolvedValue({ entries: [entry(JOB), entry(null)], total: 2 });
    const r = await listTimeEntriesTool.handler({}, ctx);
    const rows = (JSON.parse(r.content[0]!.text) as { entries: Array<{ job_id: unknown }> }).entries;
    expect(rows.map((x) => x.job_id)).toEqual([JOB, null]);
  });

  it('log_time_entry says where a job_id comes from', () => {
    const props = (logTimeEntryTool.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    expect(props.job_id?.description).toMatch(/list_time_entries/);
  });
});
