/**
 * A budget reader's driver UI (decision 15, POPIA): the server sends a per_head line without its
 * rate (`perHeadRestricted`, no `amount`) and the headcount route sends no counts. The chip names
 * no rate, the read-only editor shows the note in place of the rate and the preview, the grid's
 * driver inputs leave the line out (its row reads as its cells stand, so dependents still preview),
 * and the headcount panel shows the note in place of the counts, hires still listed.
 *
 * Mutation check: drop the restricted branch from the chip text, the editor or the panel, or keep
 * the restricted line in `driverInputs`, and a test here goes red.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriverChip } from '@/components/accounting/budgets/drivers/DriverChip';
import { DriverEditor } from '@/components/accounting/budgets/drivers/DriverEditor';
import { HeadcountPanel } from '@/components/accounting/budgets/drivers/HeadcountPanel';
import { driverDescription } from '@/components/accounting/budgets/drivers/driverText';
import { previewDriver } from '@/components/accounting/budgets/drivers/driverPreview';
import type { DriverActions } from '@/components/accounting/budgets/drivers/useDriverActions';
import { GridStore } from '@/components/accounting/budgets/workspace/gridStore';
import { visibleDriverLines, type RestrictedPerHeadLine } from '@/modules/accounting/services/budgets/drivers/perHeadAccess';
import { installNetwork, ok } from '../workspace/workspaceHarness';
import { COGS_DRIVER, ID, MONTHS, TOKEN, driverLine, driverModel } from './driverFixture';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('test over'); }));
});

const NOTE = 'Per-person detail is limited to budget editors.';
const span = { fromMonth: MONTHS[0]!, toMonth: MONTHS[11]! };
// What the server sends a reader for a one-person centre's per_head line (the real redaction).
const restricted = visibleDriverLines([driverLine({ glAccountId: ID.opex, kind: 'per_head', amount: 32017, headcountCostCentreId: ID.m1, ...span })], 'totals')[0] as RestrictedPerHeadLine;
const readerModel = () => ({ ...driverModel(), drivers: [{ ...COGS_DRIVER, ...span }, restricted] });

describe('a reader on a per_head row', () => {
  it('the chip and its description name no rate and say why', () => {
    expect(restricted).not.toHaveProperty('amount');
    render(<DriverChip line={restricted} accountName={(id) => id} description="d" warning={null} onOpen={null} />);
    expect(screen.getByTestId('driver-chip').textContent).toBe('Per head × heads');
    const words = driverDescription(restricted, (id) => id, (id) => id, () => 'CC-A Alpha');
    expect(words).toBe('Per head × headcount (CC-A Alpha), Mar 2026 to Feb 2027. Per-person detail is limited to budget editors');
    expect(words).not.toMatch(/R\s?\d|32/);
  });

  it('the grid store keeps the line for its chip but leaves it out of the preview inputs; other rows still preview', () => {
    const store = new GridStore();
    store.reset(readerModel(), { view: { kind: 'company' }, canWrite: false });
    expect(store.driverOfRow(`${ID.opex}|||`)).toEqual(restricted);
    const inputs = store.driverInputs();
    expect(inputs.drivers.map((d) => d.kind)).toEqual(['pct_of_line']);
    const r = previewDriver({ ...inputs, months: MONTHS, closedMonths: new Set(), rounding: 1 }, { ...COGS_DRIVER, ...span }, () => undefined);
    expect(r.ok && r.values[0]).toBe(38000);
  });

  it('the read-only editor shows the note, no rate field, no preview, and asks for no headcount', () => {
    const onNeedHeadcount = vi.fn();
    render(
      <DriverEditor grain={{ glAccountId: ID.opex, cc1Id: null, cc2Id: null, buId: null }} label="6000 Salaries" existing={restricted} months={MONTHS}
        rows={[]} costCentres={[{ id: ID.m1, label: 'CC-A Alpha' }]} readOnly preview={vi.fn()} onNeedHeadcount={onNeedHeadcount}
        headcountTick={0} headcountError={() => null} pathLabel={(p) => p.join(' → ')} onSave={vi.fn()} onDelete={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByTestId('per-head-restricted')).toHaveTextContent(NOTE);
    expect(screen.queryByLabelText('Amount per head a month (R)')).toBeNull();
    expect(screen.queryByTestId('driver-preview')).toBeNull();
    expect(onNeedHeadcount).not.toHaveBeenCalled();
  });
});

describe('a reader on the headcount panel', () => {
  it('shows the note in place of the counts, hires still listed', async () => {
    const net = installNetwork();
    const HIRE = { id: 'e0000000-0000-4000-8000-000000000001', label: 'Sales rep', costCentreId: null, startMonth: MONTHS[3]!, endMonth: null, fte: 1, updatedAt: TOKEN };
    net.on((u) => u.startsWith('/api/accounting/budget-drivers/headcount?'), () => ok({ costCentreId: null, perHeadRestricted: true }));
    net.on((u, m) => u.startsWith('/api/accounting/budget-drivers/planned-hires?') && m === 'GET', () => ok({ hires: [HIRE] }));
    render(<HeadcountPanel versionId={ID.version} months={MONTHS} costCentres={[]} editable={false}
      runWrite={vi.fn<DriverActions['runWrite']>()} onCountsChanged={vi.fn()} />);
    expect(await screen.findByTestId('headcount-restricted')).toHaveTextContent(NOTE);
    expect(screen.queryByTestId('headcount-table')).toBeNull();
    expect(screen.queryByTestId('headcount-as-of')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(await screen.findByDisplayValue('Sales rep')).toBeInTheDocument();
  });
});
