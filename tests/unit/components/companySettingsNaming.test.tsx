// Company settings (wave 2 L): every control in every tab has an accessible name, ids are unique per tab, and
// the page title names the tab. The browser check is n-a11y (axe `label`); this one fails fast in unit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { computeAccessibleName } from 'dom-accessibility-api';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
import { apiFetch } from '@/lib/apiFetch';
import { mapApiCompany } from '@/components/accounting/settings/mapApiCompany';
import { settingsTabTitle, TAB_IDS } from '@/components/accounting/settings/settingsNav';
import { DetailsTab } from '@/components/accounting/settings/DetailsTab';
import { GeneralTab } from '@/components/accounting/settings/GeneralTab';
import { VatTab } from '@/components/accounting/settings/VatTab';
import { ComplianceTab } from '@/components/accounting/settings/ComplianceTab';
import { DocumentsTab } from '@/components/accounting/settings/DocumentsTab';
import { BrandingTab } from '@/components/accounting/settings/BrandingTab';
import { AgingTab } from '@/components/accounting/settings/AgingTab';
import { DocMessagesTab } from '@/components/accounting/settings/DocMessagesTab';
import { EmailTemplatesTab } from '@/components/accounting/settings/EmailTemplatesTab';
import { UdfTab } from '@/components/accounting/settings/UdfTab';
import { RegionalTab } from '@/components/accounting/settings/RegionalTab';
import { CustomerZoneTab } from '@/components/accounting/settings/CustomerZoneTab';
import { NetcashTab } from '@/components/accounting/settings/NetcashTab';
import { DimensionsTab } from '@/components/accounting/settings/DimensionsTab';

const company = { ...mapApiCompany({ id: 'c1', name: 'Demo' }), lockdownEnabled: true };
const noop = () => undefined;
const docNumbers = [{ documentType: 'invoice', prefix: 'INV', nextNumber: 1, padding: 5 }];

const TABS: Array<[string, () => ReactElement]> = [
  ['details', () => <DetailsTab company={company} onChange={noop} onCompanyChange={noop} documents={[]} onDocumentsChange={noop} onError={noop} />],
  ['general', () => <GeneralTab company={company} onChange={noop} />],
  ['vat', () => <VatTab company={company} onChange={noop} />],
  ['compliance', () => <ComplianceTab />],
  ['documents', () => <DocumentsTab docNumbers={docNumbers as never} messages={{}} docDisplayFields={{}} onDocNumChange={noop} onMessageChange={noop} onDisplayFieldChange={noop} />],
  ['aging', () => <AgingTab company={company} onChange={noop} />],
  ['doc-messages', () => <DocMessagesTab messages={{}} onMessageChange={noop} />],
  ['email-templates', () => <EmailTemplatesTab company={company} onChange={noop} />],
  ['branding', () => <BrandingTab company={company} onChange={noop} onCompanyChange={noop} onError={noop} />],
  ['customer-zone', () => <CustomerZoneTab company={company} onChange={noop} />],
  ['udf', () => <UdfTab />],
  ['regional', () => <RegionalTab company={company} onChange={noop} />],
  ['netcash', () => <NetcashTab company={company} onChange={noop} />],
  ['dimensions', () => <DimensionsTab enableCC={false} enableBU={false} dimLoaded onCCChange={noop} onBUChange={noop} />],
];

beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    // The year-end-change card is not a control; keep it out (it renders nothing on a failed load).
    if (String(url).includes('financial-year-end-change')) return new Response('{}', { status: 503 });
    return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
  });
});
afterEach(cleanup);

const controls = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>('input:not([type="hidden"]), select, textarea, [role="switch"]'));

describe('company settings tabs name every control', () => {
  it.each(TABS)('%s', async (_tab, tab) => {
    const { container } = render(tab());
    // Email templates and user fields render their fields when a block is opened.
    container.querySelectorAll<HTMLButtonElement>('button[type="button"].w-full.justify-between').forEach((b) => fireEvent.click(b));
    await waitFor(() => expect(controls(container).length).toBeGreaterThan(0));
    const found = controls(container);
    const unnamed = found.filter((el) => computeAccessibleName(el).trim() === '').map((el) => el.outerHTML.slice(0, 120));
    expect(unnamed).toEqual([]);
    const ids = found.map((el) => el.id).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('settingsTabTitle', () => {
  it('names the tab before the page', () => {
    expect(settingsTabTitle('details')).toBe('Company settings · IsaFlow');
    expect(settingsTabTitle('vat')).toBe('VAT · Company settings · IsaFlow');
    expect(settingsTabTitle('general')).toBe('General · Company settings · IsaFlow');
    expect(settingsTabTitle('email-templates')).toBe('Email Templates · Company settings · IsaFlow');
  });

  it('every tab has a title of its own', () => {
    const titles = TAB_IDS.map(settingsTabTitle);
    expect(new Set(titles).size).toBe(TAB_IDS.length);
  });
});

describe('contrast fixes axe found', () => {
  it('user fields: unused rows are not dimmed (opacity-50 put enabled inputs below AA)', async () => {
    const { container } = render(<UdfTab />);
    container.querySelectorAll<HTMLButtonElement>('button[type="button"].w-full.justify-between').forEach((b) => fireEvent.click(b));
    await waitFor(() => expect(controls(container).length).toBeGreaterThan(0));
    expect(container.querySelectorAll('.opacity-50:not(button)')).toHaveLength(0);
  });

  it('netcash: the link inside the text block is underlined', () => {
    const { getByRole } = render(<NetcashTab company={company} onChange={noop} />);
    expect(getByRole('link', { name: 'netcash.co.za' }).className).toMatch(/\bunderline\b/);
  });
});

describe('user fields: names do not repeat across the entity sections', () => {
  it('each slot control names its section, e.g. "Supplier field 3 label"', async () => {
    const { container } = render(<UdfTab />);
    container.querySelectorAll<HTMLButtonElement>('button[type="button"].w-full.justify-between').forEach((b) => fireEvent.click(b));
    await waitFor(() => expect(controls(container).length).toBeGreaterThan(0));
    const names = controls(container).map((el) => computeAccessibleName(el));
    expect(names).toContain('Supplier field 3 label');
    expect(names).toContain('Item field 12 type');
    expect(new Set(names).size).toBe(names.length);
  });
});
