import { describe, it, expect } from 'vitest';
import { rollupClientTriage } from '@/modules/bureau/services/bureauClientTriageService';
import type { WorkItem, CompanyMeta } from '@/modules/bureau/services/bureauWorkTypes';

function meta(companyId: string, companyName: string, bureauId = 'b1', bureauName = 'Acme Bureau'): CompanyMeta {
  return { company_id: companyId, company_name: companyName, bureau_id: bureauId, bureau_name: bureauName };
}
function item(companyId: string, severity: WorkItem['severity'], companyName = 'X'): WorkItem {
  return {
    bureauId: 'b1', bureauName: 'Acme Bureau', companyId, companyName,
    task: 't', detail: 'd', dueAt: null, href: '/x', severity,
  };
}

describe('rollupClientTriage', () => {
  it('lights red when any item is overdue, with severity counts', () => {
    const rows = rollupClientTriage(
      [item('c1', 'overdue'), item('c1', 'due_soon'), item('c1', 'info')],
      [meta('c1', 'Brightsphere')],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId: 'c1', companyName: 'Brightsphere',
      light: 'red', overdue: 1, dueSoon: 1, info: 1, total: 3,
    });
  });

  it('lights amber when due_soon present and no overdue', () => {
    const rows = rollupClientTriage([item('c1', 'due_soon'), item('c1', 'info')], [meta('c1', 'H10')]);
    expect(rows[0]!.light).toBe('amber');
  });

  it('lights blue when only info items', () => {
    const rows = rollupClientTriage([item('c1', 'info'), item('c1', 'info')], [meta('c1', 'Acme')]);
    expect(rows[0]).toMatchObject({ light: 'blue', info: 2, total: 2 });
  });

  it('a roster client with no work items appears green', () => {
    const rows = rollupClientTriage([], [meta('c1', 'Velocity Fibre')]);
    expect(rows[0]).toMatchObject({ light: 'green', overdue: 0, dueSoon: 0, info: 0, total: 0 });
  });

  it('sorts by light rank, then overdue desc, then name', () => {
    const rows = rollupClientTriage(
      [
        item('green1', 'info'), // becomes blue
        item('red1', 'overdue'),
        item('red2', 'overdue'), item('red2', 'overdue'),
      ],
      [
        meta('clear1', 'Zeta'),     // green
        meta('green1', 'Acme'),     // blue
        meta('red1', 'Bravo'),      // red, 1 overdue
        meta('red2', 'Alpha'),      // red, 2 overdue
      ],
    );
    expect(rows.map((r) => r.companyName)).toEqual(['Alpha', 'Bravo', 'Acme', 'Zeta']);
  });

  it('carries the correct bureau id/name per row and ignores work for companies absent from the roster', () => {
    const rows = rollupClientTriage(
      [item('c1', 'overdue'), item('ghost', 'overdue')],
      [meta('c1', 'Brightsphere', 'b2', 'North Bureau')],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bureauId: 'b2', bureauName: 'North Bureau', light: 'red', overdue: 1 });
  });

  it('returns [] for an empty roster', () => {
    expect(rollupClientTriage([item('c1', 'overdue')], [])).toEqual([]);
  });
});
