/** The kit-select test helper must itself refuse a native <select>, or every test built on it proves nothing. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Select } from '@/components/ui/Select';
import { expectKitTrigger } from '../../helpers/kitSelect';

afterEach(cleanup);

describe('expectKitTrigger', () => {
  it('throws on a native select', () => {
    render(<select aria-label="Native"><option>x</option></select>);
    expect(() => expectKitTrigger(screen.getByRole('combobox', { name: 'Native' }))).toThrow();
  });

  it('throws on a combobox that does not open a listbox', () => {
    render(<div role="combobox" aria-label="Fake" aria-expanded="false" />);
    expect(() => expectKitTrigger(screen.getByRole('combobox', { name: 'Fake' }))).toThrow();
  });

  it('accepts the kit Select trigger', () => {
    render(<Select label="Kit" options={[{ value: 'a', label: 'A' }]} value={null} onChange={() => undefined} />);
    expect(() => expectKitTrigger(screen.getByRole('combobox', { name: 'Kit' }))).not.toThrow();
  });
});
