// Migration opening balances: the preview becomes labelled cards below lg; the back link, upload, amount inputs and submit are phone-sized.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/migration/TemplateDownloadCard', () => ({ TemplateDownloadCard: () => null }));

import Page from '../../../pages/accounting/migration/opening-balances';

afterEach(cleanup);
const CSV = 'Account Code,Account Name,Debit,Credit\n1000,Bank,100,0\n3000,Capital,0,100\n';
const HEADS = ['Code', 'Name', 'Debit', 'Credit'];

async function toPreview() {
  const view = render(<Page />);
  const input = view.container.querySelector('input[type=file]')!;
  fireEvent.change(input, { target: { files: [new File([CSV], 'tb.csv', { type: 'text/csv' })] } });
  await waitFor(() => expect(view.container.querySelector('table')).not.toBeNull(), { timeout: 20000 }); // first papaparse import and file read are slow on a loaded runner
  return view;
}

describe('Migration opening balances on touch', () => {
  it('turns the preview table into labelled cards whose labels equal the headers', { timeout: 30000 }, async () => {
    const { container } = await toPreview();
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    expect([...table.querySelectorAll(':scope > thead th')].map(th => th.textContent)).toEqual(HEADS);
    const rows = [...table.querySelectorAll(':scope > tbody > tr')];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect([...r.querySelectorAll(':scope > td')].map(td => td.getAttribute('data-label'))).toEqual(HEADS);
  });

  it('makes the amount inputs 44px, shrinkable beside their labels and centred in their rows', { timeout: 30000 }, async () => {
    const { container } = await toPreview();
    const inputs = [...container.querySelectorAll('tbody input')];
    expect(inputs).toHaveLength(4);
    for (const i of inputs) {
      for (const c of ['max-lg:min-h-11', 'max-lg:w-auto', 'max-lg:min-w-0', 'max-lg:flex-1']) expect(i.className.split(' '), c).toContain(c);
      expect(i.closest('td')!.className).toContain('max-lg:items-center');
    }
  });

  it('makes the back link, upload and submit buttons 44px and stacks the totals strip', { timeout: 30000 }, async () => {
    const { container } = await toPreview();
    const back = screen.getByRole('link', { name: /Back to Migration Hub/ });
    expect(back.className).toContain('max-lg:min-h-11'); // already a flex row, so it only needs the height
    expect(screen.getByRole('button', { name: /Choose CSV file/ }).className).toContain('max-lg:min-h-11');
    expect(screen.getByRole('button', { name: /Set Opening Balances/ }).className).toContain('max-lg:min-h-11');
    expect(container.querySelector('.grid-cols-3')!.className).toContain('max-lg:grid-cols-1');
  });
});
