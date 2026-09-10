import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DimensionsTab } from '@/components/accounting/settings/DimensionsTab';
import { apiFetch } from '@/lib/apiFetch';

vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); });
function Settings() {
  const [cc, setCC] = useState(false);
  const [bu, setBU] = useState(true);
  return <DimensionsTab enableCC={cc} enableBU={bu} dimLoaded onCCChange={setCC} onBUChange={setBU} />;
}

it.each([0, 1])('keeps dimension %i unchanged on HTTP failure and permits a successful retry', async index => {
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response('{}', { status: 500 }));
  render(<Settings />);
  const toggle = screen.getAllByRole('switch')[index]!;
  const before = toggle.getAttribute('aria-checked');
  fireEvent.click(toggle);
  await screen.findByRole('alert');
  expect(toggle).toHaveAttribute('aria-checked', before);
  expect(toggle).not.toBeDisabled();
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response('{}'));
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true'));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  const [url, options] = vi.mocked(apiFetch).mock.calls.at(-1)!;
  expect(url).toBe('/api/accounting/accounting-settings');
  expect(options?.method).toBe('PUT');
  expect(JSON.parse(String(options?.body))).toEqual({
    key: index === 0 ? 'enable_cost_centres' : 'enable_business_units', value: index === 0 ? 'true' : 'false',
  });
});

it('handles a rejected network request without claiming the setting changed', async () => {
  vi.mocked(apiFetch).mockRejectedValueOnce(new TypeError('Network error'));
  render(<Settings />);
  fireEvent.click(screen.getAllByRole('switch')[0]!);
  await screen.findByRole('alert');
  expect(screen.getAllByRole('switch')[0]).toHaveAttribute('aria-checked', 'false');
});

it('waits for confirmation and prevents duplicate writes while saving', async () => {
  let finish!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  render(<Settings />);
  const toggle = screen.getAllByRole('switch')[0]!;
  fireEvent.click(toggle);
  expect(toggle).toBeDisabled();
  expect(toggle).toHaveAttribute('aria-checked', 'false');
  fireEvent.click(toggle);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  await act(async () => { finish(new Response('{}')); });
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(toggle).not.toBeDisabled();
});
