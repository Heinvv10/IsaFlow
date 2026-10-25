import { describe, it, expect } from 'vitest';
import type * as React from 'react';
import { render } from '@testing-library/react';
import { Money } from '@/components/ui/Money';
import { MoneyField } from '@/components/ui/MoneyField';

describe('Money', () => {
  it('with neither amount nor cents it shows a dash, never "R NaN"', () => {
    const props = {} as unknown as React.ComponentProps<typeof Money>;
    expect(render(<Money {...props} />).container.textContent).toBe('—');
  });

  it('still shows rand amounts', () => {
    const { container } = render(<Money amount={25_000} />);
    expect(container.textContent).toBe('R 25,000.00');
  });

  it('shows integer cents exactly, with no division at the call site', () => {
    expect(render(<Money cents={2_500_000} />).container.textContent).toBe('R 25,000.00');
    expect(render(<Money cents={-12_345} />).container.textContent).toBe('-R 123.45');
    expect(render(<Money cents={8_056_294_256_317_787} />).container.textContent).toBe('R 80,562,942,563,177.87');
  });

  it('a MoneyField value goes straight into <Money cents>', () => {
    const cents = 123_456;
    const field = render(<MoneyField label="Amount" value={cents} onChange={() => undefined} />);
    const shown = render(<Money cents={cents} />);
    expect((field.getByLabelText('Amount') as HTMLInputElement).value).toBe('1,234.56');
    expect(shown.container.textContent).toBe('R 1,234.56');
  });
});
