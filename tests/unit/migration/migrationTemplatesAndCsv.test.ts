/**
 * Template downloads and the wizard's CSV reader.
 *
 * - Every template carried `# ...` guidance lines that Papa parsed as data rows
 *   (a customer named "# name: required", an account coded "# account_code").
 *   The guidance now lives beside the download button; the CSVs are data only.
 * - The five non-CoA pages called the templates API without `sourceSystem`,
 *   which the API refused. The URL builder always sends one, and the API falls
 *   back to the generic template when it is missing.
 * - The wizard parser skips `#` lines anyway, so a template downloaded before
 *   this fix still imports cleanly.
 */
import { describe, it, expect } from 'vitest';
import {
  getTemplate,
  getTemplateGuidance,
  type MigrationStep,
} from '@/modules/accounting/services/core/migrationTemplateService';
import { templateUrl } from '@/components/accounting/migration/templateUrl';
import { parseMigrationCsv } from '@/components/accounting/migration/parseMigrationCsv';

const STEPS: MigrationStep[] = ['chart-of-accounts', 'customers', 'suppliers', 'opening-balances', 'ar-invoices', 'ap-invoices'];
const SOURCES = ['sage_cloud', 'sage_50', 'xero', 'quickbooks', 'pastel', 'other', ''];

describe('migration templates', () => {
  it.each(STEPS)('%s: no template carries a # comment row, for any source', step => {
    for (const source of SOURCES) {
      const lines = getTemplate(source, step).split(/\r?\n/);
      expect(lines.filter(l => l.trim().startsWith('#'))).toEqual([]);
    }
  });

  it.each(STEPS)('%s: has guidance text for the page to show', step => {
    expect(getTemplateGuidance(step, 'other').length).toBeGreaterThan(10);
  });

  it('keeps the source-specific code-format hint as guidance', () => {
    expect(getTemplateGuidance('chart-of-accounts', 'sage_50')).toMatch(/7-digit/);
  });

  it('falls back to the generic template when no source system is given', () => {
    expect(getTemplate('', 'customers')).toContain('name,email');
    expect(getTemplate('', 'chart-of-accounts')).toContain('account_code');
  });
});

describe('templateUrl', () => {
  it('always sends the session source system, defaulting to other', () => {
    expect(templateUrl('customers', 'sage_cloud')).toBe('/api/accounting/migration/templates?sourceSystem=sage_cloud&step=customers');
    expect(templateUrl('ar-invoices', null)).toBe('/api/accounting/migration/templates?sourceSystem=other&step=ar-invoices');
    expect(templateUrl('ap-invoices', '')).toContain('sourceSystem=other');
  });
});

describe('parseMigrationCsv', () => {
  it('skips # comment lines instead of reading them as data', async () => {
    const csv = 'name,email\n# name: required\nAcme,a@acme.co.za\n\n';
    const { data, fields } = await parseMigrationCsv(csv);
    expect(fields).toEqual(['name', 'email']);
    expect(data).toEqual([{ name: 'Acme', email: 'a@acme.co.za' }]);
  });

  it('parses every generated template back into its example rows only', async () => {
    for (const step of STEPS) {
      const { data } = await parseMigrationCsv(getTemplate('other', step));
      expect(data.length).toBeGreaterThan(0);
      for (const row of data) {
        expect(Object.values(row).some(v => String(v).startsWith('#'))).toBe(false);
      }
    }
  });
});
