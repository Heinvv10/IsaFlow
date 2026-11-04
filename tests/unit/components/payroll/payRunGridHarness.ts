/**
 * The pay-run page's server, stubbed at `fetch` so the real apiFetch/apiJson run,
 * and the keystrokes the grid suites share.
 */
import { vi } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { RUN_URL, PLAN_URL, INPUTS_URL, line, runBody, planBody, inputsBody, ok } from './payrollRunFixtures';

export const TWO_LINES = [line('1', 'Riaan Smit'), line('2', 'Thandi Nkosi')];
export const twoRuns = (over: Record<string, unknown> = {}) => runBody({ lines: TWO_LINES, ...over });

export const fetchMock = vi.fn();
type Handler = (init: RequestInit) => Response | Promise<Response>;
export interface Served {
  run?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  preview?: unknown;
  /** GET …/inputs, when a test needs it to change or fail. */
  read?: () => Response;
}

export function serve(put: Handler, opts: Served = {}) {
  const run = opts.run ?? twoRuns();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === INPUTS_URL && init?.method === 'PUT') return put(init);
    if (url === INPUTS_URL) return opts.read?.() ?? ok(inputsBody(run, opts.inputs));
    if (url === RUN_URL) return ok(run);
    if (url === PLAN_URL) return ok(opts.preview ?? planBody());
    throw new Error(`unexpected fetch ${url}`);
  });
}

export const puts = () => fetchMock.mock.calls.filter(([u, i]) => u === INPUTS_URL && i?.method === 'PUT');
export const body = (n: number) => JSON.parse(String(puts()[n]![1].body)) as Record<string, unknown>;
export const previews = () => fetchMock.mock.calls.filter(([u]) => u === PLAN_URL);

export async function cell(name: string, column = 'Once-off earning') {
  return await screen.findByLabelText(`${column}, ${name}`) as HTMLInputElement;
}
export function type(input: HTMLInputElement, text: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
}
export const rowOf = (name: string) => screen.getAllByRole('row').find((r) => within(r).queryByText(name))!;
export const pressApprove = () => fireEvent.click(screen.getByRole('button', { name: /review & approve/i }));
export const settle = () => new Promise((r) => setTimeout(r, 20));
