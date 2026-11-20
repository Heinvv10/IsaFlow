/**
 * Wave 6 EZF: an EMP501 version whose stored e@syFile file is in the layout from before the BRS code fix
 * (emp501_easyfile@1) says so on the lifecycle bar: not filed, the download is rebuilt and the version should be amended;
 * filed, the stored file is kept as the record. A current stamp, and every other form, say nothing.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { FilingFileActions } from '@/components/accounting/sars/returns/FilingFileActions';
import { availableActions } from '@/components/accounting/sars/returns/returnLifecycleModel';
import type { ReturnVersionView } from '@/components/accounting/sars/returns/returnLifecycleClient';
import { V1 } from './helpers/returnLifecycleHarness';

afterEach(cleanup);
const emp501 = (over: Record<string, unknown>) => ({ ...V1, formType: 'EMP501', ...over }) as unknown as ReturnVersionView;
const show = (v: ReturnVersionView, form: 'EMP501' | 'VAT201' = 'EMP501') =>
  render(<FilingFileActions form={form} version={v} nameOf={() => 'Owner'} onStamped={() => undefined} />);
const note = () => screen.queryByTestId('filing-file-layout-note')?.textContent ?? null;

it('stamped @1, not filed: the download is rebuilt in the current layout, amend before filing', () => {
  show(emp501({ filingFileKind: 'emp501_easyfile@1' }));
  expect(note()).toMatch(/earlier e@syFile layout \(emp501_easyfile@1\).*rebuilt in the current layout.*amend the return/);
});

it('stamped @1 and filed: the stored file is kept as the record', () => {
  show(emp501({ filingFileKind: 'emp501_easyfile@1', status: 'filed' }));
  expect(note()).toMatch(/filed with a file in an earlier e@syFile layout.*kept as the record/);
});

it('a current stamp, or a VAT201, says nothing', () => {
  show(emp501({ filingFileKind: 'emp501_easyfile@2' }));
  expect(note()).toBeNull();
  cleanup();
  show({ ...V1 } as unknown as ReturnVersionView, 'VAT201');
  expect(note()).toBeNull();
});

it('Mark filed is not offered for an EMP501 stamped @1 (the server refuses it); it is for one stamped @2', () => {
  expect(availableActions(emp501({ filingFileKind: 'emp501_easyfile@1' }), 'owner', false)).toMatchObject({ file: false, amend: true });
  expect(availableActions(emp501({ filingFileKind: 'emp501_easyfile@2' }), 'owner', false).file).toBe(true);
});
