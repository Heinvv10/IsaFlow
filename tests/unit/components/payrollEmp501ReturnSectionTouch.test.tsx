// The EMP501 return section's period selector is a phone-sized target (the lifecycle bar below it is shared with the other SARS returns).
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/accounting/sars/returns/ReturnLifecycleBar', () => ({ ReturnLifecycleBar: () => null }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));

import { Emp501ReturnSection } from '../../../src/components/payroll/emp501/Emp501ReturnSection';

afterEach(cleanup);

describe('EMP501 return section on touch', () => {
  it('gives the Reconciliation selector a 44px trigger on phones', () => {
    render(<Emp501ReturnSection taxYear={2027} />);
    expect(screen.getByRole('combobox').className.split(' ')).toContain('max-lg:min-h-11');
  });
});
