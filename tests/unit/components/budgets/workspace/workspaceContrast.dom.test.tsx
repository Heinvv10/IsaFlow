/**
 * Contrast (round 1 QA-7): the shell's filled buttons use the AA fills (white on brand-600 /
 * error-600, as scripts/codemods/brand-fill-tokens.mjs maps them) and its error text the AA error
 * stops, never `--ff-brand` (#14b8a6, 2.5:1 under white) or `--ff-error-500` (#ef4444, 3.8:1).
 * Rendered DOM is audited, so a class that arrives through a ternary is seen too.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SaveBar } from '@/components/accounting/budgets/workspace/SaveBar';
import { StaleVersionDialog } from '@/components/accounting/budgets/workspace/StaleVersionDialog';
import { VersionsBar } from '@/components/accounting/budgets/workspace/VersionsBar';
import { WorkspaceEmptyState } from '@/components/accounting/budgets/workspace/WorkspaceEmptyState';
import { gridModel } from './gridFixture';

afterEach(cleanup);

const LOW = /(?:bg|text)-\[var\(--ff-(?:brand|error-500|warning-500)\)\]/;

function audit(): void {
  const all = Array.from(document.body.querySelectorAll<HTMLElement>('*'));
  expect(all.length).toBeGreaterThan(3);
  for (const el of all) {
    const cls = el.getAttribute('class') ?? '';
    expect(cls, `low-contrast token on <${el.tagName.toLowerCase()}> "${el.textContent?.slice(0, 40)}"`).not.toMatch(LOW);
    if (/(?<![\w:-])text-white(?![\w-])/.test(cls)) expect(cls).toMatch(/(?<![\w:-])bg-(?:brand-600|brand-700|error-600|error-700)(?![\w/-])/);
  }
}

const version = { ...gridModel().version!, isPrimary: false };

describe('workspace shell contrast', () => {
  it('SaveBar: Save, the error line and the Discard confirm', () => {
    render(<SaveBar dirtyCount={2} saveState={{ status: 'error', message: 'Failed', retryAfter: null }} readOnly={false} onSave={vi.fn()} onDiscard={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    audit();
  });

  it('StaleVersionDialog: stale and locked, with an error line', async () => {
    const base = { message: 'm', currentUpdatedAt: null, versionStatus: null, failedChunk: 0, chunks: 1, dirtyCount: 1 } as const;
    const { rerender } = render(<StaleVersionDialog stale={{ ...base, kind: 'stale' }} onChoose={async () => 'Could not load.'} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reload and re-apply mine' }));
    await screen.findByRole('alert');
    audit();
    rerender(<StaleVersionDialog stale={{ ...base, kind: 'locked' }} onChoose={async () => null} onClose={vi.fn()} />);
    audit();
  });

  it('version dialogs: approve, delete, unlock with an over-long reason and a refusal', async () => {
    const props = { versions: [version], role: 'owner', dirtyCount: 0, disabled: false, compareVersionId: null,
      onSelect: vi.fn(), onCompare: vi.fn(), onNewReforecast: vi.fn(), onAction: vi.fn(async () => 'Refused.') };
    const { rerender } = render(<VersionsBar {...props} current={version} />);
    fireEvent.click(screen.getByTestId('version-approve'));
    fireEvent.click(within(screen.getByTestId('version-dialog-approve')).getByRole('button', { name: 'Approve' }));
    await screen.findByRole('alert');
    audit();
    fireEvent.click(within(screen.getByTestId('version-dialog-approve')).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByTestId('version-delete'));
    audit();
    fireEvent.click(within(screen.getByTestId('version-dialog-delete')).getByRole('button', { name: 'Cancel' }));
    rerender(<VersionsBar {...props} current={{ ...version, status: 'locked' }} />);
    fireEvent.click(screen.getByTestId('version-unlock'));
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'x'.repeat(501) } });
    audit();
  });

  it('empty states: source buttons and the chart-of-accounts link', () => {
    const { rerender } = render(<WorkspaceEmptyState fiscalYear={2027} noAccounts={false} canWrite canCopy onStart={vi.fn()} />);
    audit();
    rerender(<WorkspaceEmptyState fiscalYear={2027} noAccounts canWrite canCopy onStart={vi.fn()} />);
    audit();
  });
});
