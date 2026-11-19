import { describe, it, expect, afterEach } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AmountInput, type AmountInputProps } from '@/components/ui/AmountInput';
import { normaliseAmountText } from '@/components/ui/amountInputText';

afterEach(cleanup);

/** Types like a keyboard: a selection is replaced by the key, otherwise the key goes at the end. */
function type(input: HTMLInputElement, keys: string) {
  for (const ch of keys) {
    const replaced = input.selectionStart === 0 && input.selectionEnd === input.value.length && input.value.length > 0;
    fireEvent.change(input, { target: { value: (replaced ? '' : input.value) + ch } });
    input.setSelectionRange(input.value.length, input.value.length);
  }
}
const field = () => screen.getByLabelText('amt') as HTMLInputElement;

function TextHarness({ initial, ...rest }: { initial: string } & Partial<AmountInputProps>) {
  const [text, setText] = useState(initial);
  return (<form><AmountInput aria-label="amt" value={text} onValueChange={(_n, t) => setText(t)} {...rest} /><output data-testid="stored">{text}</output></form>);
}
function NumberHarness() {
  const [n, setN] = useState(0);
  return (<><AmountInput aria-label="amt" value={n} onValueChange={v => setN(v)} /><output data-testid="stored">{String(n)}</output></>);
}

describe('AmountInput (#1654): typing and focus', () => {
  it('a field that starts at 0 selects it on focus, so typing 2325.32 stores 2325.32', () => {
    render(<TextHarness initial="0" />);
    fireEvent.focus(field());
    expect([field().selectionStart, field().selectionEnd]).toEqual([0, 1]);
    type(field(), '2325.32');
    expect(field().value).toBe('2325.32');
    expect(screen.getByTestId('stored').textContent).toBe('2325.32');
  });

  it('selects 0.00 on focus too, and not a non-zero amount', () => {
    render(<TextHarness initial="0.00" />);
    fireEvent.focus(field());
    expect(field().selectionEnd! - field().selectionStart!).toBe(4);
    cleanup();
    render(<TextHarness initial="150.00" />);
    fireEvent.focus(field());
    expect(field().selectionStart).toBe(field().selectionEnd);
  });

  it('the mouseup of the click that focused a zero is cancelled, so the selection survives a real click', () => {
    render(<TextHarness initial="0" />);
    fireEvent.mouseDown(field());
    fireEvent.focus(field());
    expect(fireEvent.mouseUp(field())).toBe(false); // preventDefault: the browser keeps the selection
    expect(fireEvent.mouseUp(field())).toBe(true); // only the first one
  });

  it('a numeric parent keeps the partial text: "0." and "2325." are not parsed back', () => {
    render(<NumberHarness />);
    type(field(), '0.');
    expect(field().value).toBe('0.');
    fireEvent.change(field(), { target: { value: '' } });
    type(field(), '2325.');
    expect(field().value).toBe('2325.');
    type(field(), '32');
    expect(screen.getByTestId('stored').textContent).toBe('2325.32');
  });

  it('resync keeps "2325." while the parent number equals it, and follows a different parent value', () => {
    function Fill() {
      const [t, setT] = useState('10');
      return (<><AmountInput aria-label="amt" value={t} onValueChange={(_n, x) => setT(x)} /><button type="button" onClick={() => setT('99.50')}>fill</button><AmountInput aria-label="num" value={2325} onValueChange={() => undefined} /></>);
    }
    render(<Fill />);
    fireEvent.click(screen.getByText('fill'));
    expect(field().value).toBe('99.50');
    type(field(), '0');
    fireEvent.change(field(), { target: { value: '2325.' } });
    expect(field().value).toBe('2325.');
  });

  it('clearing to empty gives text "" and number 0', () => {
    let seen: [number, string] = [-1, 'x'];
    render(<AmountInput aria-label="amt" value="5" onValueChange={(n, t) => { seen = [n, t]; }} />);
    fireEvent.change(field(), { target: { value: '' } });
    expect(seen).toEqual([0, '']);
  });
});

describe('AmountInput (#1654): decimals and refusals', () => {
  it('rejects a third decimal while typing (default 2) and accepts it with decimals={3}', () => {
    render(<TextHarness initial="" />);
    type(field(), '12.345');
    expect(field().value).toBe('12.34');
    expect(field().getAttribute('aria-invalid')).toBe('true');
    cleanup();
    render(<TextHarness initial="" decimals={3} />);
    type(field(), '12.345');
    expect(field().value).toBe('12.345');
  });

  it('refuses letters and a second decimal point, then recovers on the next good key', () => {
    render(<TextHarness initial="" />);
    type(field(), '1a');
    expect(field().value).toBe('1');
    expect(field().validationMessage).not.toBe('');
    type(field(), '2.3.4');
    expect(field().value).toBe('12.34');
    expect(field().validationMessage).toBe('');
  });

  it('a lone "." is invalid (validity + aria-invalid) and the form refuses to submit it', () => {
    render(<TextHarness initial="" />);
    type(field(), '.');
    expect(field().value).toBe('.');
    expect(field().validity.valid).toBe(false);
    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect(field().form!.checkValidity()).toBe(false);
    type(field(), '5');
    expect(field().validity.valid).toBe(true);
    expect(field().getAttribute('aria-invalid')).toBeNull();
  });

  it('required: empty is invalid, filled is valid; optional empty is valid', () => {
    render(<TextHarness initial="" required />);
    expect(field().validity.valid).toBe(false);
    type(field(), '3');
    expect(field().validity.valid).toBe(true);
    cleanup();
    render(<TextHarness initial="" />);
    expect(field().validity.valid).toBe(true);
  });

  it('min and max drive the validity message', () => {
    render(<TextHarness initial="" min={0.01} max={100} />);
    type(field(), '0');
    expect(field().validationMessage).toContain('at least 0.01');
    fireEvent.change(field(), { target: { value: '100.01' } });
    expect(field().validationMessage).toContain('more than 100');
    fireEvent.change(field(), { target: { value: '100' } });
    expect(field().validity.valid).toBe(true);
  });
});

describe('AmountInput (#1654): paste', () => {
  it.each([
    ['R 1 234,56', '1234.56'], ['R100', '100'], ['1,234.50', '1234.50'], ['1,234', '1234'], ['12,5', '12.5'], ['1.234,56', '1234.56'],
  ])('normalises a pasted "%s" to %s', (pasted, expected) => {
    expect(normaliseAmountText(pasted)).toBe(expected);
    render(<TextHarness initial="" />);
    fireEvent.change(field(), { target: { value: pasted } });
    expect(field().value).toBe(expected);
  });

  it('rejects a pasted non-amount and keeps the old text, flagged invalid', () => {
    render(<TextHarness initial="5" />);
    fireEvent.change(field(), { target: { value: '5 apples' } });
    expect(field().value).toBe('5');
    expect(field().getAttribute('aria-invalid')).toBe('true');
  });
});

describe('AmountInput (#1654): review follow-ups', () => {
  it('decimals>=3: "1,234" is ambiguous and refused (aria-invalid), "1,23" and "1,2345" are not thousands; decimals=2 still reads 1,234 as 1234', () => {
    expect(normaliseAmountText('1,234', 3)).toBe('1,234');
    expect(normaliseAmountText('1,234', 2)).toBe('1234');
    expect(normaliseAmountText('1,5', 3)).toBe('1.5');
    expect(normaliseAmountText('1,234,567', 3)).toBe('1234567');
    render(<TextHarness initial="" decimals={3} />);
    fireEvent.change(field(), { target: { value: '1,234' } });
    expect(field().value).toBe('');
    expect(field().getAttribute('aria-invalid')).toBe('true');
  });

  it('a refusal survives blur (so a Submit click still sees it) and clears on the next valid change or a parent reset', () => {
    function Reset() {
      const [t, setT] = useState('5');
      return (<form><AmountInput aria-label="amt" value={t} onValueChange={(_n, x) => setT(x)} /><button type="button" onClick={() => setT('7')}>reset</button></form>);
    }
    render(<Reset />);
    fireEvent.change(field(), { target: { value: '5x' } });
    fireEvent.blur(field());
    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect(field().form!.checkValidity()).toBe(false);
    fireEvent.change(field(), { target: { value: '56' } });
    expect(field().getAttribute('aria-invalid')).toBeNull();
    fireEvent.change(field(), { target: { value: '5x' } });
    fireEvent.click(screen.getByText('reset'));
    expect(field().value).toBe('7');
    expect(field().getAttribute('aria-invalid')).toBeNull();
  });

  it('blur forgets a pending focus, so a later plain mouseup is not cancelled', () => {
    render(<TextHarness initial="0" />);
    fireEvent.focus(field());
    fireEvent.blur(field());
    expect(fireEvent.mouseUp(field())).toBe(true);
  });

  it('a string parent reset to "" clears a typed 5; a number parent reset to 0 clears a typed number', () => {
    function StrReset() {
      const [t, setT] = useState('');
      return (<><AmountInput aria-label="amt" value={t} onValueChange={(_n, x) => setT(x)} /><button type="button" onClick={() => setT('')}>reset</button></>);
    }
    render(<StrReset />);
    type(field(), '5');
    fireEvent.click(screen.getByText('reset'));
    expect(field().value).toBe('');
    cleanup();
    function NumReset() {
      const [n, setN] = useState(0);
      return (<><AmountInput aria-label="amt" value={n} onValueChange={v => setN(v)} /><button type="button" onClick={() => setN(0)}>reset</button></>);
    }
    render(<NumReset />);
    type(field(), '12.5');
    fireEvent.click(screen.getByText('reset'));
    expect(field().value).toBe('');
  });

  it('a number-or-"" parent (value={n || \'\'}) shows the same number again after a 0 cleared it', () => {
    function PickInvoice() {
      const [n, setN] = useState(0);
      return (<><AmountInput aria-label="amt" value={n || ''} onValueChange={v => setN(v)} />
        <button type="button" onClick={() => setN(100)}>pick</button><button type="button" onClick={() => setN(0)}>none</button></>);
    }
    render(<PickInvoice />);
    fireEvent.click(screen.getByText('pick'));
    expect(field().value).toBe('100');
    fireEvent.click(screen.getByText('none'));
    expect(field().value).toBe('');
    fireEvent.click(screen.getByText('pick'));
    expect(field().value).toBe('100');
  });
});

describe('AmountInput (#1654 follow-up): a `n || \'\'` parent', () => {
  function OrEmpty({ start }: { start: number }) {
    const [n, setN] = useState(start);
    return (<><AmountInput aria-label="amt" value={n || ''} onValueChange={v => setN(v)} /><output data-testid="stored">{String(n)}</output></>);
  }
  it('typing "0.75" over 100 keeps every keystroke (the "0" step hands back \'\' and must not wipe the draft)', () => {
    render(<OrEmpty start={100} />);
    fireEvent.focus(field());
    field().select();
    type(field(), '0.75');
    expect(field().value).toBe('0.75');
    expect(screen.getByTestId('stored').textContent).toBe('0.75');
  });
  it('typing "0" over 100 shows 0, and a later parent value is still adopted', () => {
    function Fill() {
      const [n, setN] = useState(100);
      return (<><AmountInput aria-label="amt" value={n || ''} onValueChange={v => setN(v)} /><button type="button" onClick={() => setN(100)}>hundred</button></>);
    }
    render(<Fill />);
    fireEvent.change(field(), { target: { value: '0' } });
    expect(field().value).toBe('0');
    fireEvent.click(screen.getByText('hundred'));
    expect(field().value).toBe('100');
  });
});
