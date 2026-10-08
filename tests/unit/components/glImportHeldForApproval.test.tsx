/**
 * R-035 PR6 (UI): a GL import with post-immediately leaves the journals a
 * manual-journal rule governs as drafts awaiting approval; the result says how
 * many, and says nothing when none were held.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { ImportStep } from '@/components/accounting/gl-import/GlImportWizardSteps';

const summary = { validations: [], validCount: 4, errorCount: 0, warningCount: 0, totalDebit: 2000, totalCredit: 2000, isBalanced: true };
const step = (heldForApproval: string[]) => render(
  <ImportStep validRows={[]} summary={summary} postImmediately onPostModeChange={vi.fn()} onBack={vi.fn()} onImport={vi.fn()}
    importing={false} importError="" onViewEntries={vi.fn()} onReset={vi.fn()}
    importResult={{ entriesCreated: 2, linesCreated: 4, totalValue: 2000, heldForApproval }} />);

describe('the GL import result', () => {
  it('says how many journals were held for approval', () => {
    step(['je-1']);
    expect(screen.getByText('1 held for approval — left as drafts until approved.')).toBeDefined();
  });

  it('says nothing about approval when none were held', () => {
    step([]);
    expect(screen.queryByText(/held for approval/)).toBeNull();
  });
});
