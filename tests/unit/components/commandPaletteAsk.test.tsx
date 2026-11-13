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
  it('clicks the explanation button of the figure that had focus, and closes the palette', () => {
    const onExplain = vi.fn();
    const onClose = vi.fn();
    render(<>
      <table><tbody><tr><td><input aria-label="paye cell" /><button data-explain-trigger onClick={onExplain}>i</button></td></tr></tbody></table>
      <CommandPalette isOpen onClose={onClose} />
    </>);
    fireEvent.focusIn(screen.getByLabelText('paye cell'));
    fireEvent.click(screen.getByText('Explain this figure'));
    expect(onExplain).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says so, and stays open, when focus is not on an explainable figure', () => {
    const onClose = vi.fn();
    render(<><input aria-label="plain" /><CommandPalette isOpen onClose={onClose} /></>);
    fireEvent.focusIn(screen.getByLabelText('plain'));
    fireEvent.click(screen.getByText('Explain this figure'));
    expect(screen.getByTestId('explain-note').textContent).toMatch(/Nothing to explain/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('forgets the figure once focus left the page for nothing (a click on blank space)', () => {
    const onExplain = vi.fn();
    render(<><button data-explain-trigger onClick={onExplain}>i</button><CommandPalette isOpen onClose={() => undefined} /></>);
    const trigger = screen.getByText('i');
    fireEvent.focusIn(trigger);
    fireEvent.focusOut(trigger, { relatedTarget: null });
    fireEvent.click(screen.getByText('Explain this figure'));
    expect(onExplain).not.toHaveBeenCalled();
    expect(screen.getByTestId('explain-note')).toBeTruthy();
  });

  it('refuses to guess between two figures', () => {
    const a = vi.fn(); const b = vi.fn();
    render(<><div><span aria-label="row" tabIndex={0} /><button data-explain-trigger onClick={a}>1</button><button data-explain-trigger onClick={b}>2</button></div><CommandPalette isOpen onClose={() => undefined} /></>);
    fireEvent.focusIn(screen.getByLabelText('row'));
    fireEvent.click(screen.getByText('Explain this figure'));
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(screen.getByTestId('explain-note')).toBeTruthy();
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
