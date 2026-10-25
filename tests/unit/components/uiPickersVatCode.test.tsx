// VatCodePicker: a static, searchable list typed from RuleVatCode. Nothing to load, so no request, no loading
// state, no create row.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VatCodePicker } from '@/components/ui';

const trigger = (name: string) => screen.getByRole('combobox', { name });

describe('VatCodePicker', () => {
  it('lists the four VAT codes, standard at the statutory rate, synchronously on open', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<VatCodePicker label="VAT" value={null} onChange={() => {}} />);
    fireEvent.click(trigger('VAT'));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['No VAT', 'Standard 15%', 'Zero Rated', 'Exempt']);
    expect(screen.queryByRole('status')).toBeNull(); // no "Loading…"
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('filters by typeahead, restricts codes, and selects with the keyboard', () => {
    const onChange = vi.fn();
    render(<VatCodePicker label="VAT" codes={['standard', 'zero_rated', 'exempt']} value={null} onChange={onChange} />);
    fireEvent.keyDown(trigger('VAT'), { key: 'Enter' });
    expect(screen.queryByRole('option', { name: 'No VAT' })).toBeNull();
    const search = screen.getByRole('textbox', { name: 'Search VAT' });
    fireEvent.change(search, { target: { value: 'zero' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Zero Rated']);
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('zero_rated', expect.objectContaining({ label: 'Zero Rated' }));
  });

  it('displays the current value, even one outside `codes`, without opening', () => {
    const { rerender } = render(<VatCodePicker label="VAT" value="standard" onChange={() => {}} />);
    expect(trigger('VAT').textContent).toContain('Standard 15%');
    rerender(<VatCodePicker label="VAT" codes={['none']} value="exempt" onChange={() => {}} />);
    expect(trigger('VAT').textContent).toContain('Exempt');
  });

  it('has no create row and no way to ask for one', async () => {
    render(<VatCodePicker label="VAT" value={null} onChange={() => {}} />);
    fireEvent.click(trigger('VAT'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search VAT' }), { target: { value: 'reduced' } });
    await waitFor(() => expect(screen.queryAllByRole('option')).toHaveLength(0));
    expect(screen.getByRole('status').textContent).toBe('No options');
  });

  it('clears to null when clearable', () => {
    const onChange = vi.fn();
    render(<VatCodePicker label="VAT" value="standard" clearable onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(onChange).toHaveBeenCalledWith(null, null);
  });
});
