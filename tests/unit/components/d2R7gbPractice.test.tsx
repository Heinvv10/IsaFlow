/**
 * D2 round 7 (gb): work items, job categories and the add-year modal show the server message on a refusal and a plain
 * sentence on an empty 500 (never the helper's raw Error text). REAL assertOk / apiErrorMessage over a scripted apiFetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, empty500, expectNoRawError, ok, refuse, script } from '../helpers/d2R3a5';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import { WorkItemManager } from '../../../src/components/practice/WorkItemManager';
import { AddYearModal } from '../../../src/components/accounting/financialYears/AddYearModal';
import JobCategoriesPage from '../../../pages/accounting/practice/job-categories/index';

useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('work items', () => {
  const add = async () => {
    fireEvent.change(await screen.findByPlaceholderText(/New work item name/), { target: { value: 'Audit' } });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
  };
  it('a refused add shows the server message', async () => {
    script((u, m) => (m === 'POST' ? refuse() : ok([]))); render(<WorkItemManager categoryId="c1" />); await add();
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('an empty-500 add shows a plain sentence', async () => {
    script((u, m) => (m === 'POST' ? empty500() : ok([]))); render(<WorkItemManager categoryId="c1" />); await add();
    expect(await screen.findByText('Could not add the work item - try again')).toBeTruthy(); expectNoRawError();
  });
  it('a wrong-shape load (a 200 that is not a list) is a plain sentence, not the helper text', async () => {
    script(() => ok({ nope: 1 })); render(<WorkItemManager categoryId="c1" />);
    expect(await screen.findByText('Could not load the work items - try again')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/expected an array/);
  });
  it('an empty-500 load is a plain sentence', async () => {
    script(() => empty500()); render(<WorkItemManager categoryId="c1" />);
    expect(await screen.findByText('Could not load the work items - try again')).toBeTruthy(); expectNoRawError();
  });
});

describe('job categories page', () => {
  it('an empty-500 load is a plain sentence and a wrong-shape 200 hides the helper text', async () => {
    script(() => empty500()); render(<JobCategoriesPage />);
    expect(await screen.findByText('Could not load the job categories - try again')).toBeTruthy(); cleanup();
    script(() => ok({ nope: 1 })); render(<JobCategoriesPage />);
    expect(await screen.findByText('Could not load the job categories - try again')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/expected an array/);
  });
  it('a refused add shows the server message, an empty 500 a plain sentence', async () => {
    const add = async () => {
      fireEvent.change(await screen.findByPlaceholderText(/categor/i), { target: { value: 'Tax' } });
      fireEvent.click(await screen.findByRole('button', { name: /^Add$/ }));
    };
    script((u, m) => (m === 'POST' ? refuse() : ok([]))); render(<JobCategoriesPage />); await add();
    expect(await screen.findByText(MSG)).toBeTruthy(); cleanup();
    script((u, m) => (m === 'POST' ? empty500() : ok([]))); render(<JobCategoriesPage />); await add();
    expect(await screen.findByText('Could not add the category - try again')).toBeTruthy(); expectNoRawError();
  });
});

describe('add year modal', () => {
  it('keeps the modal open and shows a server-sourced message (ApiEnvelopeError) from the parent', async () => {
    const { ApiEnvelopeError } = await import('@/lib/apiFetch');
    const onClose = vi.fn();
    render(<AddYearModal existingYears={[2024]} onConfirm={async () => { throw new ApiEnvelopeError(MSG); }} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create Year' }));
    expect(await screen.findByText(MSG)).toBeTruthy(); expect(onClose).not.toHaveBeenCalled();
  });
  it('a plain transport error shows a sentence, not its text', async () => {
    render(<AddYearModal existingYears={[2024]} onConfirm={async () => { throw new TypeError('Failed to fetch'); }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create Year' }));
    expect(await screen.findByText('Could not create the financial year - try again')).toBeTruthy();
  });
});
