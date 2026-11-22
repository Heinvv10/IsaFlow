// GL import wizard: the header and step indicator wrap, the column-mapping table becomes cards, and the controls are 44px on phones.
import type { ReactNode } from 'react';
import ExcelJS from 'exceljs';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, asPath: '/', isReady: true, push: vi.fn(), replace: vi.fn() }) }));

import Page from '../../../pages/accounting/gl-import';

afterEach(cleanup);

async function toMappingStep() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('GL');
  ws.addRow(['Date', 'Account Code', 'Description', 'Debit', 'Credit']);
  ws.addRow(['2026-11-01', '1000', 'Opening', 100, 0]);
  ws.addRow(['2026-11-02', '4000', 'Sales', 0, 100]);
  const buf = await wb.xlsx.writeBuffer();
  const file = new File([buf], 'gl.xlsx');
  const view = render(<Page />);
  const input = await waitFor(() => { const i = view.container.querySelector('input[type=file]'); if (!i) throw new Error('no input yet'); return i; });
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByText(/data rows detected/, undefined, { timeout: 10000 });
  return view;
}

describe('GL import on touch', () => {
  it('wraps the header and step indicator and sizes the template link on phones', async () => {
    const { container } = render(<Page />);
    const link = await screen.findByRole('link', { name: /Download Template/ });
    expect(link.className).toContain('max-lg:min-h-11');
    expect(link.parentElement!.className).toContain('max-lg:flex-wrap');
    // Four steps with arrows do not fit a 360px screen: the row wraps and the arrows go.
    const steps = screen.getByText('Upload').closest('div')!.parentElement!.parentElement!;
    expect(steps.className).toContain('max-lg:flex-wrap');
    for (const arrow of container.querySelectorAll('svg.lucide-arrow-right')) expect(arrow.getAttribute('class')).toContain('max-lg:hidden');
  });

  it('turns the column-mapping table into labelled cards with 44px selects', async () => {
    const { container } = await toMappingStep();
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    const first = table.querySelector(':scope > tbody > tr')!;
    // Source column heads the card (no label); the select and each preview row are labelled.
    expect([...first.querySelectorAll(':scope > td')].map(td => td.getAttribute('data-label'))).toEqual([null, 'Maps To', 'Row 1', 'Row 2']);
    const select = first.querySelector('select')!;
    expect(select.className).toContain('max-lg:min-h-11');
    expect(select.closest('td')!.className).toContain('max-lg:items-center');
    expect(first.querySelectorAll(':scope > td')[2].className.split(' ')).toEqual(expect.arrayContaining(['max-lg:max-w-none', 'max-lg:whitespace-normal']));
  });

  it('makes Back and Validate 44px', async () => {
    await toMappingStep();
    for (const name of [/Back/, /Validat/]) expect(screen.getByRole('button', { name }).className, String(name)).toContain('max-lg:min-h-11');
  });
});
