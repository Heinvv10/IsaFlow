/**
 * Wave 6 EFa (coordinator ruling on M2a): a filing that went ahead without the PRN cross-check, because the company's
 * VAT or PAYE number on file is not a valid SARS number, shows the named warning on its version in the drawer.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReturnVersionsDrawer } from '@/components/accounting/sars/returns/ReturnVersionsDrawer';
import type { ReturnVersionView } from '@/components/accounting/sars/returns/returnLifecycleClient';
import { V1 } from './helpers/returnLifecycleHarness';

const WARNING = 'The company VAT number on file is not a valid SARS number; the PRN was not cross-checked.';
const filed = { ...V1, status: 'filed', filedReference: '4555555555V00000009', drift: null, filingWarnings: [WARNING] };
const draw = (v: unknown) => render(<ReturnVersionsDrawer open onClose={() => undefined} form="VAT201"
  versions={[v as ReturnVersionView]} vatReturn={null} nameOf={(id) => id} />);

describe('versions drawer: filing warnings', () => {
  it('shows the named PRN warning on the version that was filed with it', () => {
    draw(filed);
    expect(screen.getByRole('article', { name: 'Version 1' })).toHaveTextContent(WARNING);
    expect(screen.getAllByTestId('filing-warning')).toHaveLength(1);
  });

  it('shows nothing for a version filed without a warning', () => {
    draw({ ...filed, filingWarnings: [] });
    expect(screen.queryByTestId('filing-warning')).toBeNull();
  });
});
