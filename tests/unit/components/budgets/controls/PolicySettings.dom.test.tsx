/**
 * Budget controls settings form (P5-4 review r2): a save sends ONLY the fields the user changed (a
 * company whose stored email flag is on while the server switch is off must still be able to change
 * its policy: re-sending `alertEmailEnabled: true` would be a 409); an unsaved edit survives a
 * refresh that brings the same saved settings, and gives way when the saved settings change; the
 * comma-separated threshold field is a text keyboard, not a numeric one.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PolicySettings } from '@/components/accounting/budgets/controls/PolicySettings';
import type { ControlsView } from '@/components/accounting/budgets/controls/controlsClient';

afterEach(cleanup);

const view = (over: Partial<ControlsView['settings']> = {}, server = false): ControlsView => ({
  settings: { checkPolicy: 'warn', alertEmailEnabled: true, defaultThresholds: [80, 100, 120], updatedAt: '2026-11-03T08:00:00.000Z', ...over },
  overrides: [], options: { accounts: [], cc1: [], cc2: [], units: [] }, emailAllowedOnServer: server, lastEvaluated: { daily: null, manual: null },
});

describe('PolicySettings', () => {
  it('sends only the changed field: a stored email flag with the server switch off is not re-sent', () => {
    const onSave = vi.fn(async () => true);
    render(<PolicySettings view={view()} canEdit busy={false} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('Budget check on bill approval'), { target: { value: 'block' } });
    fireEvent.click(screen.getByTestId('budget-settings-save'));
    expect(onSave).toHaveBeenCalledWith({ checkPolicy: 'block' });
  });

  it('sends the thresholds alone when only they changed', () => {
    const onSave = vi.fn(async () => true);
    render(<PolicySettings view={view({ alertEmailEnabled: false }, true)} canEdit busy={false} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('Default alert thresholds (% of budget)'), { target: { value: '120, 90' } });
    fireEvent.click(screen.getByTestId('budget-settings-save'));
    expect(onSave).toHaveBeenCalledWith({ defaultThresholds: [90, 120] });
  });

  it('keeps an unsaved edit across a refresh with the same saved settings; resets when they change', () => {
    const { rerender } = render(<PolicySettings view={view()} canEdit busy={false} onSave={vi.fn(async () => true)} />);
    const field = () => screen.getByLabelText('Default alert thresholds (% of budget)') as HTMLInputElement;
    fireEvent.change(field(), { target: { value: '50, 75' } });
    rerender(<PolicySettings view={view()} canEdit busy={false} onSave={vi.fn(async () => true)} />);
    expect(field().value).toBe('50, 75');
    rerender(<PolicySettings view={view({ defaultThresholds: [70], updatedAt: '2026-11-03T09:00:00.000Z' })} canEdit busy={false} onSave={vi.fn(async () => true)} />);
    expect(field().value).toBe('70');
  });

  it('the threshold field takes text (commas), not a numeric keypad', () => {
    render(<PolicySettings view={view()} canEdit busy={false} onSave={vi.fn(async () => true)} />);
    expect(screen.getByLabelText('Default alert thresholds (% of budget)')).toHaveAttribute('inputmode', 'text');
  });
});
