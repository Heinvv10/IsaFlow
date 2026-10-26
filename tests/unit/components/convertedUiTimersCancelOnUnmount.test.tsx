/** Auto-dismiss timers converted to useTimeoutOnce: unmounting before they fire leaves no pending timer. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanyPicker } from '@/components/admin/CompanyPicker';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());

afterEach(() => { cleanup(); vi.useRealTimers(); });

it('CompanyPicker: the blur close timer is cancelled when the picker unmounts', () => {
  vi.useFakeTimers();
  const view = render(<CompanyPicker value={[]} onChange={vi.fn()} />);
  fireEvent.blur(screen.getByRole('combobox'));
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
