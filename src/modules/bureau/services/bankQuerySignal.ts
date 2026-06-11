/**
 * WhatsApp bank-tx query signal for the /bureau cockpit and /home feed.
 *
 * TENANT SAFETY: runs on the RLS-bypassing @/lib/neon pool. The query filters
 * company_id = ANY(${companyIds}); companyIds is bureau-derived by the caller.
 * The pure shaper drops rows whose company_id is not in the supplied meta map.
 */
import { sql } from '@/lib/neon';
import type { WorkItem, CompanyMeta } from './bureauWorkTypes';

export interface BankQueryCountRow {
  company_id: string;
  replied: number;
  awaiting: number;
  oldest_sent: string | Date | null;
}

const STALE_DAYS = 3;
const MS_PER_DAY = 86_400_000;

export function shapeBankQueries(
  rows: BankQueryCountRow[],
  meta: Map<string, CompanyMeta>,
  today: Date,
): WorkItem[] {
  const items: WorkItem[] = [];
  for (const r of rows) {
    const m = meta.get(r.company_id);
    if (!m) continue;
    const replied = Number(r.replied) || 0;
    const awaiting = Number(r.awaiting) || 0;
    if (replied > 0) {
      items.push({
        bureauId: m.bureau_id,
        bureauName: m.bureau_name,
        companyId: r.company_id,
        companyName: m.company_name,
        task: 'Client replies to review',
        detail: `${replied} WhatsApp ${replied === 1 ? 'reply' : 'replies'} to bank queries awaiting review`,
        dueAt: null,
        href: '/accounting/bank/queries',
        severity: 'due_soon',
      });
      continue;
    }
    if (awaiting > 0 && r.oldest_sent) {
      const oldest = r.oldest_sent instanceof Date ? r.oldest_sent : new Date(r.oldest_sent);
      const ageDays = Math.floor((today.getTime() - oldest.getTime()) / MS_PER_DAY);
      if (ageDays >= STALE_DAYS) {
        items.push({
          bureauId: m.bureau_id,
          bureauName: m.bureau_name,
          companyId: r.company_id,
          companyName: m.company_name,
          task: 'Awaiting client reply',
          detail: `${awaiting} bank ${awaiting === 1 ? 'query' : 'queries'} sent, oldest ${ageDays}d ago`,
          dueAt: null,
          href: '/accounting/bank/queries',
          severity: 'info',
        });
      }
    }
  }
  return items;
}

export async function bankQuerySignal(
  companyIds: string[],
  meta: Map<string, CompanyMeta>,
  today: Date,
): Promise<WorkItem[]> {
  const rows = (await sql`
    SELECT company_id,
           COUNT(*) FILTER (WHERE status = 'replied')::int AS replied,
           COUNT(*) FILTER (WHERE status = 'sent')::int   AS awaiting,
           MIN(sent_at) FILTER (WHERE status = 'sent')    AS oldest_sent
    FROM bank_tx_queries
    WHERE company_id = ANY(${companyIds})
      AND status IN ('sent', 'replied')
    GROUP BY company_id
  `) as unknown as BankQueryCountRow[];
  return shapeBankQueries(rows, meta, today);
}
