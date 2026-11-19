/**
 * Wave 6 EFa (66a1c14834 review): availableActions offers Mark filed for a finalised version once its filing file is
 * stamped, or at once when no file is required (finalised before 999v's cut-off: filingFileRequired false). An
 * unknown requirement (undefined, an older server) offers nothing, and a version that is not finalised never offers it,
 * nor the "finalised before filing files" note.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { availableActions } from '@/components/accounting/sars/returns/returnLifecycleModel';
import { FilingFileActions } from '@/components/accounting/sars/returns/FilingFileActions';
import type { ReturnVersionView } from '@/components/accounting/sars/returns/returnLifecycleClient';
import { V1 } from './helpers/returnLifecycleHarness';

afterEach(cleanup);
const unstamped = (over: Record<string, unknown>) =>
  ({ ...V1, filingFileSha256: null, filingFileKind: null, filingFileAt: null, filingFileBy: null, ...over }) as unknown as ReturnVersionView;
const PRE_CUTOFF_NOTE = /finalised before IsaFlow generated filing files/;

describe('availableActions and filingFileRequired', () => {
  it('L1: finalised, no stamp: Mark filed only when filingFileRequired is false (not true, not undefined)', () => {
    expect(availableActions(unstamped({ filingFileRequired: false }), 'owner', false).file).toBe(true);
    expect(availableActions(unstamped({ filingFileRequired: true }), 'owner', false).file).toBe(false);
    expect(availableActions(unstamped({ filingFileRequired: undefined }), 'owner', false).file).toBe(false);
    // A stamped version is offered whatever the flag says.
    expect(availableActions({ ...unstamped({ filingFileRequired: true }), filingFileSha256: 'a'.repeat(64) }, 'owner', false).file).toBe(true);
  });

  it('L2: a version that is not finalised, with filingFileRequired false: no Mark filed and no pre-cut-off note', () => {
    for (const status of ['filed', 'superseded']) {
      const v = unstamped({ status, filingFileRequired: false });
      expect(availableActions(v, 'owner', false).file, status).toBe(false);
      render(<FilingFileActions form="VAT201" version={v} nameOf={(id) => id} onStamped={() => undefined} />);
      expect(screen.getByTestId('filing-file-status').textContent ?? '', status).not.toMatch(PRE_CUTOFF_NOTE);
      cleanup();
    }
    // The control: finalised and not required does carry that note.
    render(<FilingFileActions form="VAT201" version={unstamped({ filingFileRequired: false })} nameOf={(id) => id} onStamped={() => undefined} />);
    expect(screen.getByTestId('filing-file-status').textContent ?? '').toMatch(PRE_CUTOFF_NOTE);
  });
});
