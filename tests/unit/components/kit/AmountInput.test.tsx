import { describe, it, expect, afterEach } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AmountInput } from '@/components/ui/AmountInput';

afterEach(cleanup);

/** Types like a keyboard: a selection is replaced by the key, otherwise the key goes at the end. */
function type(input: HTMLInputElement, keys: string) {
  for (const ch of keys) {
    const replaced = input.selectionStart === 0 && input.selectionEnd === input.value.length && input.value.length > 0;
    fireEvent.change(input, { target: { value: (replaced ? '' : input.value) + ch } });
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function TextHarness({ initial }: { initial: string }) {
  const [text, setText] = useState(initial);
  return (<><AmountInput aria-label="amt" value={text} onValueChange={(_n, t) => setText(t)} /><output data-testid="stored">{text}</output></>);
}
function NumberHarness() {
  const [n, setN] = useState(0);
  return (<><AmountInput aria-label="amt" value={n} onValueChange={v => setN(v)} /><output data-testid="stored">{String(n)}</output></>);
}

describe('AmountInput (#1654)', () => {
  it('a field that starts at 0 selects it on focus, so typing 2325.32 stores 2325.32', () => {
    render(<TextHarness initial="0" />);
    const input = screen.getByLabelText('amt') as HTMLInputElement;
    fireEvent.focus(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(1);
    type(input, '2325.32');
    expect(input.value).toBe('2325.32');
    expect(screen.getByTestId('stored').textContent).toBe('2325.32');
  });

  it('selects 0.00 on focus too', () => {
    render(<TextHarness initial="0.00" />);
    const input = screen.getByLabelText('amt') as HTMLInputElement;
    fireEvent.focus(input);
    expect(input.selectionEnd - input.selectionStart).toBe(4);
  });

  it('does not select a non-zero amount on focus', () => {
    render(<TextHarness initial="150.00" />);
    const input = screen.getByLabelText('amt') as HTMLInputElement;
    fireEvent.focus(input);
    expect(input.selectionStart).toBe(input.selectionEnd);
  });

  it('a numeric parent keeps the partial text: "0." and "2325." are not parsed back to 0 / 2325', () => {
    render(<NumberHarness />);
    const input = screen.getByLabelText('amt') as HTMLInputElement;
    type(input, '0.');
    expect(input.value).toBe('0.');
    fireEvent.change(input, { target: { value: '' } });
    type(input, '2325.');
    expect(input.value).toBe('2325.');
    type(input, '32');
    expect(input.value).toBe('2325.32');
    expect(screen.getByTestId('stored').textContent).toBe('2325.32');
  });

  it('refuses letters and a second decimal point', () => {
    render(<TextHarness initial="" />);
    const input = screen.getByLabelText('amt') as HTMLInputElement;
    type(input, '1a2.3.4');
    expect(input.value).toBe('12.34');
  });

  it('follows the parent when it sets a different value', () => {
    function Fill() {
      const [t, setT] = useState('10');
      return (<><AmountInput aria-label="amt" value={t} onValueChange={(_n, x) => setT(x)} /><button onClick={() => setT('99.50')}>fill</button></>);
    }
    render(<Fill />);
    fireEvent.click(screen.getByText('fill'));
    expect((screen.getByLabelText('amt') as HTMLInputElement).value).toBe('99.50');
  });
});
