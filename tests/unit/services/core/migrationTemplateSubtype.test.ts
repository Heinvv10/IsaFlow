/**
 * The downloadable CoA templates are what a migrating client fills in. A
 * template with no account_subtype column produces a CSV in which every
 * cost-of-sales account silently lands under operating expenses.
 */
import { describe, it, expect } from 'vitest';
import { getTemplate } from '@/modules/accounting/services/core/migrationTemplateService';

const SOURCES = ['generic', 'sage-cloud', 'sage-50', 'xero', 'quickbooks'] as const;

describe('chart-of-accounts CSV templates', () => {
  it.each(SOURCES)('%s carries account_subtype and fills it on every revenue/expense row', (source) => {
    const csv = getTemplate(source, 'chart-of-accounts');
    const [header, ...body] = csv.trim().split('\n');
    const cols = header!.split(',');
    const typeIx = cols.indexOf('account_type');
    const subIx = cols.indexOf('account_subtype');
    expect(subIx).toBeGreaterThan(-1);
    const bare = body
      .filter(l => l && !l.startsWith('#'))
      .map(l => l.split(','))
      .filter(p => (p[typeIx] === 'revenue' || p[typeIx] === 'expense') && !p[subIx]);
    expect(bare).toEqual([]);
  });
});
