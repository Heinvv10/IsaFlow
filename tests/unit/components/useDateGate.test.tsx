import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useState } from 'react';
import { DateField } from '@/components/ui';
import { GatedDateField } from '@/components/forms/GatedDateField';
import { useDateGate } from '@/hooks/useDateGate';

function Probe(): JSX.Element {
  const [d, setD] = useState('2026-10-01');
  const gate = useDateGate();
  return (
    <div>
      <DateField label="When" value={d || null} onChange={gate.bind('when', setD)} />
      <output data-testid="iso">{d}</output>
      <output data-testid="blocked">{String(gate.blocked)}</output>
    </div>
  );
}

const type = (text: string): void => {
  const input = screen.getByRole('textbox', { name: /when/i });
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
};

it('stores typed text as ISO and is not blocked', () => {
  render(<Probe />);
  type('5 Oct 2026');
  expect(screen.getByTestId('iso').textContent).toBe('2026-10-05');
  expect(screen.getByTestId('blocked').textContent).toBe('false');
});

it('blocks, keeping the old date, on refused text, and unblocks once a date is typed', () => {
  render(<Probe />);
  type('zz');
  expect(screen.getByTestId('blocked').textContent).toBe('true');
  expect(screen.getByTestId('iso').textContent).toBe('2026-10-01');
  type('t');
  expect(screen.getByTestId('blocked').textContent).toBe('false');
});

it('tracks fields independently', () => {
  const { result } = renderHook(() => useDateGate());
  const a = result.current.bind('a', () => undefined);
  const b = result.current.bind('b', () => undefined);
  act(() => a(null, { valid: false, reason: 'x' }));
  act(() => b(null, { valid: true, reason: null }));
  expect(result.current.blocked).toBe(true);
});

it('drops a refusal when the parent later sets a different date', () => {
  function Parent(): JSX.Element {
    const [d, setD] = useState('2026-10-01');
    const gate = useDateGate();
    return (
      <div>
        <DateField label="When" value={d || null} onChange={gate.bind('when', setD, d)} />
        <button type="button" onClick={() => setD('2026-11-02')}>scan</button>
        <button type="button" onClick={() => { if (gate.blocked) setD('stuck'); }}>submit</button>
        <output data-testid="iso">{d}</output>
      </div>
    );
  }
  render(<Parent />);
  type('zz');
  fireEvent.click(screen.getByText('submit'));
  expect(screen.getByTestId('iso').textContent).toBe('stuck');
  fireEvent.click(screen.getByText('scan'));
  expect(screen.getByTestId('iso').textContent).toBe('2026-11-02');
  fireEvent.click(screen.getByText('submit'));
  expect(screen.getByTestId('iso').textContent).toBe('2026-11-02');
});

it('reset forgets one field', () => {
  const { result } = renderHook(() => useDateGate());
  act(() => result.current.bind('a', () => undefined)(null, { valid: false, reason: 'x' }));
  expect(result.current.blocked).toBe(true);
  act(() => result.current.reset('a'));
  expect(result.current.blocked).toBe(false);
});

it('a deliberate re-set of the SAME date (scan-fill) clears the refusal and puts the date back on screen', () => {
  function Parent(): JSX.Element {
    const [d, setD] = useState('2026-10-01');
    const gate = useDateGate();
    return (
      <div>
        <DateField label="When" value={d || null} resetKey={gate.resetKey('when')} onChange={gate.bind('when', setD, d)} />
        <button type="button" onClick={() => { gate.reset('when'); setD('2026-10-01'); }}>scan</button>
        <output data-testid="blocked">{String(gate.blocked)}</output>
      </div>
    );
  }
  render(<Parent />);
  type('zz');
  expect(screen.getByTestId('blocked').textContent).toBe('true');
  fireEvent.click(screen.getByText('scan'));
  expect(screen.getByTestId('blocked').textContent).toBe('false');
  expect((screen.getByRole('textbox', { name: /when/i }) as HTMLInputElement).value).toBe('01 Oct 2026');
  expect(screen.getByRole('textbox', { name: /when/i }).getAttribute('aria-invalid')).not.toBe('true');
});

it('resetKey changes only for the field that was reset', () => {
  const { result } = renderHook(() => useDateGate());
  const before = [result.current.resetKey('a'), result.current.resetKey('b')];
  act(() => result.current.reset('a'));
  expect(result.current.resetKey('a')).not.toBe(before[0]);
  expect(result.current.resetKey('b')).toBe(before[1]);
});

/** The parent reads `blocked` while it renders, BEFORE the child GatedDateField has bound this render's value. */
function ReadsBeforeBind({ onRender }: { onRender?: (blocked: boolean) => void }): JSX.Element {
  const [d, setD] = useState('2026-10-01');
  const gate = useDateGate();
  const blocked = gate.blocked;
  onRender?.(blocked);
  return (
    <div>
      <button type="button" disabled={blocked}>save</button>
      <GatedDateField label="When" value={d || null} gate={gate} gateKey="when" onValue={setD} />
      <button type="button" onClick={() => setD('2026-11-02')}>scan</button>
      <button type="button" onClick={() => setD('2026-10-01')}>restore</button>
      <button type="button" onClick={() => { if (gate.blocked) setD('2026-12-31'); }}>submit</button>
      <output data-testid="iso">{d}</output>
    </div>
  );
}

const save = (): HTMLButtonElement => screen.getByText('save') as HTMLButtonElement;

it('a refusal disables the button on the render it causes, even read before the field binds', () => {
  const seen: boolean[] = [];
  render(<ReadsBeforeBind onRender={(b) => seen.push(b)} />);
  expect(save().disabled).toBe(false);
  seen.length = 0;
  type('zz');
  expect(save().disabled).toBe(true);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen).not.toContain(false);
});

it('a new date from the parent re-enables a button that read blocked before the field bound', () => {
  render(<ReadsBeforeBind />);
  type('zz');
  expect(save().disabled).toBe(true);
  fireEvent.click(screen.getByText('scan'));
  expect(screen.getByTestId('iso').textContent).toBe('2026-11-02');
  expect(save().disabled).toBe(false);
});

it('the parent going back to the refused date does not bring the dropped refusal back', () => {
  render(<ReadsBeforeBind />);
  type('zz');
  fireEvent.click(screen.getByText('scan'));
  fireEvent.click(screen.getByText('restore'));
  expect(save().disabled).toBe(false);
  fireEvent.click(screen.getByText('submit'));
  expect(screen.getByTestId('iso').textContent).toBe('2026-10-01');
});

it('a gate held from an earlier render answers with the current state, both ways', () => {
  const { result } = renderHook(() => useDateGate());
  const held = result.current;
  const a = held.bind('a', () => undefined, 'x');
  act(() => a(null, { valid: false, code: 'unreadable', reason: 'x' }));
  expect(held.blocked).toBe(true);
  act(() => result.current.reset('a'));
  expect(held.blocked).toBe(false);
});
