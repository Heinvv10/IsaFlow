import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import OfflinePage from '../../../pages/offline';

describe('OfflinePage', () => {
  it('says the user is offline and to reconnect', () => {
    render(<OfflinePage />);
    expect(screen.getByText(/you.re offline/i)).toBeTruthy();
    expect(screen.getByText(/reconnect to continue/i)).toBeTruthy();
  });

  it('makes no offline-feature claim', () => {
    render(<OfflinePage />);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/available offline/i);
    expect(text).not.toMatch(/some features/i);
  });

  it('keeps the IsaFlow brand and has no em dash', () => {
    render(<OfflinePage />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('IsaFlow');
    expect(document.body.textContent ?? '').not.toContain('\u2014');
  });

  it('keeps the retry button', () => {
    render(<OfflinePage />);
    expect(screen.getByRole('button', { name: /retry connection/i })).toBeTruthy();
  });
});
