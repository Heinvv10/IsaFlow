/**
 * The row-header driver chip (P4 spec §7): its words per driver kind, the click that opens the
 * editor, the read-only form for a reader, and the warning state a skipped driver (DRIVER_SKIPPED)
 * or a missing input puts it in.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriverChip } from '@/components/accounting/budgets/drivers/DriverChip';
import { driverChipText } from '@/components/accounting/budgets/drivers/driverText';
import { ID, MONTHS, driverLine } from './driverFixture';

afterEach(cleanup);

const names: Record<string, string> = { [ID.rev1]: 'Sales' };
const nameOf = (id: string) => names[id] ?? id;
const ref = { glAccountId: ID.rev1, cc1Id: null, cc2Id: null, buId: null };

describe('chip text per kind', () => {
  it.each([
    ['pct_of_line', driverLine({ glAccountId: ID.cos1, kind: 'pct_of_line', pct: 38, ref }), '38% × Sales'],
    ['growth', driverLine({ glAccountId: ID.rev2, kind: 'growth', pct: 2, baseMonth: MONTHS[0]!, fromMonth: MONTHS[1]! }), '+2% m/m from Mar'],
    ['negative growth', driverLine({ glAccountId: ID.rev2, kind: 'growth', pct: -1.5, baseMonth: MONTHS[0]!, fromMonth: MONTHS[1]! }), '-1.5% m/m from Mar'],
    ['per_head', driverLine({ glAccountId: ID.opex, kind: 'per_head', amount: 32000 }), 'R 32 000 × heads'],
    ['fixed', driverLine({ glAccountId: ID.opex, kind: 'fixed', amount: 15000 }), 'R 15 000 fixed'],
    ['fixed with cents', driverLine({ glAccountId: ID.opex, kind: 'fixed', amount: 99.5 }), 'R 99.50 fixed'],
    ['pct_of_section', driverLine({ glAccountId: ID.opex, kind: 'pct_of_section', pct: 5, section: 'turnover', scope: 'company' }), '5% of Turnover'],
  ])('%s', (_kind, line, text) => {
    expect(driverChipText(line, nameOf)).toBe(text);
    render(<DriverChip line={line} accountName={nameOf} description="d" warning={null} onOpen={vi.fn()} />);
    expect(screen.getByTestId('driver-chip').textContent).toBe(text);
  });
});

describe('DriverChip', () => {
  const line = driverLine({ glAccountId: ID.cos1, kind: 'pct_of_line', pct: 38, ref });

  it('a writer clicks it to open the editor', () => {
    const onOpen = vi.fn();
    render(<DriverChip line={line} accountName={nameOf} description="38% of 1000 Sales, Mar 2026 to Feb 2027" warning={null} onOpen={onOpen} />);
    const chip = screen.getByRole('button', { name: /Driver: 38% × Sales/ });
    expect(chip).toHaveAttribute('title', '38% of 1000 Sales, Mar 2026 to Feb 2027');
    fireEvent.click(chip);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('a reader gets the same words, not a button', () => {
    render(<DriverChip line={line} accountName={nameOf} description="d" warning={null} onOpen={null} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('driver-chip')).toHaveTextContent('38% × Sales');
  });

  it('a skipped driver shows the warning state with its message', () => {
    const warning = 'driver on 2000 Cost of sales cannot compute: 1000 Sales is not an income-statement account; change or delete the driver';
    render(<DriverChip line={line} accountName={nameOf} description="d" warning={warning} onOpen={vi.fn()} />);
    const chip = screen.getByTestId('driver-chip');
    expect(chip).toHaveAttribute('data-warning', 'true');
    expect(chip.getAttribute('title')).toContain(warning);
    expect(chip.getAttribute('aria-label')).toContain(warning);
  });
});
