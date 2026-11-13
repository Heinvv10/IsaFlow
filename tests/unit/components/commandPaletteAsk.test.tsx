import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(), asPath: '/', query: {}, pathname: '/' }) }));
vi.mock('next/link', () => ({ default: ({ href, children, onClick }: { href: string; children: unknown; onClick?: () => void }) => <a href={href} onClick={onClick}>{children as string}</a> }));
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ toggleTheme: vi.fn() }) }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-A' } }) }));
const apiFetch = vi.fn();
const apiJson = vi.fn();
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  apiJson: (...a: unknown[]) => apiJson(...a),
  assertOk: async () => undefined,
  apiErrorMessage: (_e: unknown, fb: string) => fb,
}));

import { CommandPalette } from '@/components/layout/CommandPalette';

beforeEach(() => {
  apiFetch.mockReset(); apiJson.mockReset(); localStorage.clear();
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { results: [] } }) });
});
afterEach(cleanup);

describe('Explain this figure', () => {
  const figure = (onExplain: () => void) => (
    <table><tbody><tr><td data-explain-scope><span aria-label="paye text" tabIndex={0}>R 1.00</span><button data-explain-trigger onClick={onExplain}>i</button></td>
      <td data-explain-scope><span aria-label="other text" tabIndex={0}>R 2.00</span></td></tr></tbody></table>
  );

  it('clicks the explanation button of the figure that had focus, and closes the palette', () => {
    const onExplain = vi.fn();
    const onClose = vi.fn();
    render(<>{figure(onExplain)}<CommandPalette isOpen onClose={onClose} /></>);
    fireEvent.focusIn(screen.getByLabelText('paye text'));
    fireEvent.click(screen.getByText('Explain this figure'));
    expect(onExplain).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a click on the figure counts although it focuses nothing', () => {
    const onExplain = vi.fn();
    render(<>{figure(onExplain)}<CommandPalette isOpen onClose={() => undefined} /></>);
    fireEvent.pointerDown(screen.getByText('R 1.00'));
    fireEvent.click(screen.getByText('Explain this figure'));
    expect(onExplain).toHaveBeenCalledTimes(1);
  });

  it('a figure with no explanation next to an explainable one does not borrow its button', () => {
    const onExplain = vi.fn();
    render(<>{figure(onExplain)}<CommandPalette isOpen onClose={() => undefined} /></>);
    fireEvent.pointerDown(screen.getByText('R 2.00'));
    fireEvent.click(screen.getByText('Explain this figure'));
    expect(onExplain).not.toHaveBeenCalled();
    expect(screen.getByTestId('explain-note')).toBeTruthy();
  });

  it('says so, and stays open, when the position is not on an explainable figure', () => {
    const onClose = vi.fn();
    render(<><input aria-label="plain" /><CommandPalette isOpen onClose={onClose} /></>);
    fireEvent.focusIn(screen.getByLabelText('plain'));
    fireEvent.click(screen.getByText('Explain this figure'));
    expect(screen.getByTestId('explain-note').textContent).toMatch(/Nothing to explain/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clicking a figure after another control had focus still explains that figure (the blur is not a loss)', () => {
    const onExplain = vi.fn();
    render(<><button>other</button>{figure(onExplain)}<CommandPalette isOpen onClose={() => undefined} /></>);
    const other = screen.getByText('other');
    fireEvent.focusIn(other);
    fireEvent.pointerDown(screen.getByText('R 1.00'));
    fireEvent.focusOut(other, { relatedTarget: null }); // the click on non-focusable text blurs the button to nothing
    fireEvent.click(screen.getByText('Explain this figure'));
    expect(onExplain).toHaveBeenCalledTimes(1);
  });

  it('a click on blank space after a figure means nothing is focused any more', () => {
    const onExplain = vi.fn();
    render(<>{figure(onExplain)}<div>blank</div><CommandPalette isOpen onClose={() => undefined} /></>);
    fireEvent.pointerDown(screen.getByText('R 1.00'));
    fireEvent.pointerDown(screen.getByText('blank'));
    fireEvent.click(screen.getByText('Explain this figure'));
    expect(onExplain).not.toHaveBeenCalled();
    expect(screen.getByTestId('explain-note')).toBeTruthy();
  });

  it('refuses to guess when a scope holds two figures\' buttons', () => {
    const a = vi.fn(); const b = vi.fn();
    render(<><div data-explain-scope><span aria-label="row" tabIndex={0} /><button data-explain-trigger onClick={a}>1</button><button data-explain-trigger onClick={b}>2</button></div><CommandPalette isOpen onClose={() => undefined} /></>);
    fireEvent.focusIn(screen.getByLabelText('row'));
    fireEvent.click(screen.getByText('Explain this figure'));
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(screen.getByTestId('explain-note')).toBeTruthy();
  });

  it('does not walk out of a figure to a lone button elsewhere on the page', () => {
    const onExplain = vi.fn();
    render(<><input aria-label="unrelated" /><button data-explain-trigger onClick={onExplain}>i</button><CommandPalette isOpen onClose={() => undefined} /></>);
    fireEvent.focusIn(screen.getByLabelText('unrelated'));
    fireEvent.click(screen.getByText('Explain this figure'));
    expect(onExplain).not.toHaveBeenCalled();
  });
});

describe('a typed question', () => {
  const type = (v: string) => fireEvent.change(screen.getByRole('combobox'), { target: { value: v } });
  const answerOnce = () => apiJson.mockResolvedValue({ understood: true, text: 'Customers owe you R 5.00.', figure: 5, lines: [], link: null, suggestions: [] });

  it.each(['who owes me money', 'what was profit last month', 'How much cash do I have?', 'is my vat due?'])('"%s" gets an Ask IsaFlow row first, and Enter answers it', async (q) => {
    answerOnce();
    render(<CommandPalette isOpen onClose={() => undefined} />);
    type(q);
    expect(screen.getAllByRole('option')[0]!.textContent).toContain(`Ask IsaFlow: ${q}`);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect((await screen.findByTestId('ask-text')).textContent).toContain('R 5.00');
    expect(apiJson.mock.calls[0]![0]).toBe(`/api/accounting/ask?q=${encodeURIComponent(q)}`);
  });

  it('a phrase that is also a page search gets the row last, so Enter still opens the page; one word gets none', () => {
    render(<CommandPalette isOpen onClose={() => undefined} />);
    type('aged debtors');
    const options = screen.getAllByRole('option');
    expect(options[options.length - 1]!.textContent).toContain('Ask IsaFlow: aged debtors');
    expect(options[0]!.textContent).not.toContain('Ask IsaFlow: ');
    type('vat');
    expect(screen.getAllByRole('option').some((o) => o.textContent?.includes('Ask IsaFlow: '))).toBe(false);
  });
});

describe('Ask IsaFlow', () => {
  it('sends the question to the ask route and shows the answer with its link', async () => {
    apiJson.mockResolvedValue({ understood: true, text: 'Customers owe you R 1 250.75 across 2 customers.', figure: 1250.75, lines: [{ label: 'Acme', value: 1000.5 }], link: { href: '/accounting/ar-aging', label: 'Open AR aging' }, suggestions: [] });
    render(<CommandPalette isOpen onClose={() => undefined} />);
    fireEvent.click(screen.getByText('Ask IsaFlow'));
    fireEvent.change(screen.getByLabelText('Ask IsaFlow a question'), { target: { value: 'who owes me money?' } });
    fireEvent.submit(screen.getByLabelText('Ask IsaFlow a question').closest('form')!);
    expect((await screen.findByTestId('ask-text')).textContent).toContain('R 1 250.75');
    expect(apiJson.mock.calls[0]![0]).toBe('/api/accounting/ask?q=who%20owes%20me%20money%3F');
    expect(screen.getByText('Open AR aging').getAttribute('href')).toBe('/accounting/ar-aging');
    expect(screen.getByText('R 1 000.50')).toBeTruthy();
  });

  it('an unrecognised question lists example questions that can be tried', async () => {
    apiJson.mockResolvedValueOnce({ understood: false, text: 'I can only answer a fixed set of questions.', figure: null, lines: [], link: null, suggestions: ['Who owes me money?'] });
    render(<CommandPalette isOpen onClose={() => undefined} />);
    fireEvent.click(screen.getByText('Ask IsaFlow'));
    fireEvent.change(screen.getByLabelText('Ask IsaFlow a question'), { target: { value: 'weather' } });
    fireEvent.submit(screen.getByLabelText('Ask IsaFlow a question').closest('form')!);
    expect(await screen.findByText('Who owes me money?')).toBeTruthy();
  });

  it('shows a plain sentence when the route fails', async () => {
    apiJson.mockRejectedValueOnce(new Error('boom'));
    render(<CommandPalette isOpen onClose={() => undefined} />);
    fireEvent.click(screen.getByText('Ask IsaFlow'));
    fireEvent.change(screen.getByLabelText('Ask IsaFlow a question'), { target: { value: 'cash in bank' } });
    fireEvent.submit(screen.getByLabelText('Ask IsaFlow a question').closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toBe('Could not answer that - try again');
  });
});
