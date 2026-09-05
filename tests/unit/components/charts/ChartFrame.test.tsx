import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { ChartFrame } from '@/components/accounting/charts/ChartFrame';

vi.mock('@/components/charts/EChartClient', () => ({
  EChartClient: ({ option }: { option: Record<string, unknown> }) => (
    <div data-testid="echart" data-option={JSON.stringify(option)} />
  ),
}));

afterEach(cleanup);

describe('ChartFrame', () => {
  it('states the unit next to the title, so a reader never guesses the scale', () => {
    render(
      <ChartFrame title="Profit bridge" unit="Rand, period to date">
        {() => ({ series: [] })}
      </ChartFrame>,
    );
    expect(screen.getByText('Profit bridge')).toBeTruthy();
    expect(screen.getByText('Rand, period to date')).toBeTruthy();
  });

  it('passes a palette to the builder and renders what it returns', () => {
    render(
      <ChartFrame title="T" unit="Rand">
        {(p) => ({ series: [{ type: 'bar', itemStyle: { color: p.ink } }] })}
      </ChartFrame>,
    );
    const opt = JSON.parse(screen.getByTestId('echart').getAttribute('data-option') ?? '{}');
    expect(opt.series[0].itemStyle.color).toBeTruthy();
  });

  it('states the condition instead of drawing an empty chart when the builder returns null', () => {
    render(
      <ChartFrame title="T" unit="Rand" unavailable="Opening cash is negative; a flow diagram would misstate it.">
        {() => null}
      </ChartFrame>,
    );
    expect(screen.queryByTestId('echart')).toBeNull();
    expect(screen.getByText(/Opening cash is negative/)).toBeTruthy();
  });

  it('re-resolves the palette when the DOM theme class changes, so a client-side toggle repaints every chart', async () => {
    const style = document.createElement('style');
    style.textContent = `
      :root { --ff-text-primary: #111111; }
      .dark { --ff-text-primary: #eeeeee; }
    `;
    document.head.appendChild(style);
    const seen: string[] = [];

    render(
      <ChartFrame title="T" unit="Rand">
        {(p) => { seen.push(p.ink); return { series: [] }; }}
      </ChartFrame>,
    );

    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    const initialInk = seen[seen.length - 1];

    await act(async () => {
      document.documentElement.classList.add('dark');
      // MutationObserver callbacks fire as a microtask, after the mutation
      // that triggers them — flush the microtask queue before asserting.
      await Promise.resolve();
    });

    await waitFor(() => expect(seen[seen.length - 1]).not.toBe(initialInk));

    document.documentElement.classList.remove('dark');
    document.head.removeChild(style);
  });
});
