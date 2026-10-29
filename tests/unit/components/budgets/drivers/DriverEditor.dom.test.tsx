/**
 * The driver editor drawer (P4 spec §7): field validation before anything is sent, the live
 * preview of every version month computed with the PURE engine over the grid's cells (an
 * override the driver leaves alone is shown as kept), a loop found by the preview or answered by
 * the server (400 DRIVER_CYCLE + path) shown inline with the row labels, Save with the line the
 * PUT route takes, Delete, and Escape closing it.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriverEditor, type DriverEditorProps } from '@/components/accounting/budgets/drivers/DriverEditor';
import { previewDriver } from '@/components/accounting/budgets/drivers/driverPreview';
import { costCentreOptions, refRowOptions, rowLabels } from '@/components/accounting/budgets/drivers/driverRows';
import { GridStore } from '@/components/accounting/budgets/workspace/gridStore';
import type { DriverGrain, DriverLine, StoredDriverLine } from '@/modules/accounting/services/budgets/drivers/driverLine';
import { COGS_DRIVER, ID, MONTHS, driverModel } from './driverFixture';

afterEach(cleanup);

const g = (glAccountId: string): DriverGrain => ({ glAccountId, cc1Id: null, cc2Id: null, buId: null });
const key = (id: string) => `${id}|||`;

function setup(grain: DriverGrain, existing: StoredDriverLine | null, over: Partial<DriverEditorProps> = {}) {
  const model = driverModel();
  const store = new GridStore();
  store.reset(model, { view: { kind: 'company' }, canWrite: true });
  const labels = rowLabels(model.accounts, model.dimensions);
  const preview = (line: DriverLine) => previewDriver({ ...store.driverInputs(), months: MONTHS, closedMonths: store.getClosedMonths(), rounding: 1 }, line, () => undefined);
  const onSave = vi.fn(async (_line: DriverLine) => null);
  const onDelete = vi.fn(async () => null);
  const onClose = vi.fn();
  render(
    <DriverEditor grain={grain} label={labels.row(key(grain.glAccountId))} existing={existing} months={MONTHS}
      rows={refRowOptions(model.accounts, store.driverInputs().values, key(grain.glAccountId), labels)} costCentres={costCentreOptions(model.dimensions)}
      readOnly={false} preview={preview} onNeedHeadcount={vi.fn()} headcountTick={0} pathLabel={(p) => p.map(labels.row).join(' → ')}
      onSave={onSave} onDelete={onDelete} onClose={onClose} {...over} />,
  );
  return { onSave, onDelete, onClose };
}

const dialog = () => screen.getByRole('dialog', { name: 'Set a driver' });
const previewRow = (month: string) => within(screen.getByTestId('driver-preview')).getByRole('rowheader', { name: month }).closest('tr')!;

describe('DriverEditor', () => {
  it('refuses to save until the amount is a number; then saves the fixed line over the whole version', async () => {
    const { onSave } = setup(g(ID.opex), null);
    expect(dialog()).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('driver-editor-save'));
    expect(await screen.findByText('Type an amount')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Amount a month (R)'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId('driver-editor-save'));
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Amount a month (R)'), { target: { value: '12 500' } });
    expect(previewRow('Mar 2026')).toHaveTextContent('R 12 500.00');
    expect(previewRow('Feb 2027')).toHaveTextContent('R 12 500.00');
    fireEvent.change(screen.getByLabelText('Round each month to'), { target: { value: '1000' } });
    expect(previewRow('Mar 2026')).toHaveTextContent('R 13 000.00');
    fireEvent.click(screen.getByTestId('driver-editor-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toEqual({
      glAccountId: ID.opex, cc1Id: null, cc2Id: null, buId: null, kind: 'fixed', fromMonth: MONTHS[0], toMonth: MONTHS[11], rounding: 1000,
      amount: 12500, pct: null, ref: null, section: null, scope: null, baseMonth: null, headcountCostCentreId: null,
    });
  });

  it('a month range that runs backwards and a growth base inside the range are refused', async () => {
    const { onSave } = setup(g(ID.opex), null);
    fireEvent.change(screen.getByLabelText('Driver'), { target: { value: 'growth' } });
    fireEvent.change(screen.getByLabelText('Growth a month (%)'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: MONTHS[5] } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: MONTHS[2] } });
    fireEvent.click(screen.getByTestId('driver-editor-save'));
    expect(await screen.findByText('The first month comes after the last')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('To'), { target: { value: MONTHS[11] } });
    fireEvent.change(screen.getByLabelText('Base month'), { target: { value: MONTHS[5] } });
    fireEvent.click(screen.getByTestId('driver-editor-save'));
    expect(await screen.findByText('The base month comes before the first driven month')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('previews the edited percentage from the engine, keeping the typed-over month', () => {
    setup(g(ID.cos1), COGS_DRIVER);
    expect(screen.getByRole('dialog', { name: 'Edit driver' })).toBeInTheDocument();
    expect(previewRow('Apr 2026')).toHaveTextContent('R 380.00');
    fireEvent.change(screen.getByLabelText('Percentage (%)'), { target: { value: '41.5' } });
    expect(previewRow('Apr 2026')).toHaveTextContent('R 415.00');
    // May was typed over (an override): the driver never writes it.
    expect(previewRow('May 2026')).toHaveTextContent('R 500.00 (override kept)');
  });

  it('a loop the preview finds is shown with its path, and Save is off', () => {
    const { onSave } = setup(g(ID.rev1), null);
    fireEvent.change(screen.getByLabelText('Driver'), { target: { value: 'pct_of_line' } });
    fireEvent.change(screen.getByLabelText('Percentage (%)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Of the line'), { target: { value: key(ID.cos1) } });
    expect(screen.getByTestId('driver-cycle').textContent).toMatch(/This driver makes a loop: (1000 Account 1000 → 2000 Account 2000 → 1000 Account 1000|2000 Account 2000 → 1000 Account 1000 → 2000 Account 2000)/);
    expect(screen.getByTestId('driver-editor-save')).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("the server's 400 DRIVER_CYCLE path is labelled inline; Delete and Escape", async () => {
    const onSave = vi.fn(async () => ({ message: 'This driver makes a loop', path: [key(ID.cos1), key(ID.rev1), key(ID.cos1)] }));
    const { onDelete, onClose } = setup(g(ID.cos1), COGS_DRIVER, { onSave });
    fireEvent.click(screen.getByTestId('driver-editor-save'));
    expect(await screen.findByTestId('driver-editor-error')).toHaveTextContent('This driver makes a loop: 2000 Account 2000 → 1000 Account 1000 → 2000 Account 2000');
    fireEvent.click(screen.getByRole('button', { name: 'Delete driver' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
