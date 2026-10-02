/**
 * The two print pages, mounted the way Next mounts them: hydrating nothing,
 * rendering the REAL component against the page's own fetches. Bundled for the
 * browser by `bundlePrintPages.ts`.
 */
import { createRoot } from 'react-dom/client';
import { PackPagesPrintPage } from '@/components/accounting/packs/PackPagesPrintPage';
import { PackPrintPage } from '@/components/accounting/packs/PackPrintPage';

const q = new URLSearchParams(window.location.search);
const props = { packType: q.get('pack') === 'board' ? 'board' : 'management', from: '2026-01-01', to: '2026-08-31' } as const;
const root = document.getElementById('root')!;
createRoot(root).render(props.packType === 'board' ? <PackPagesPrintPage {...props} /> : <PackPrintPage {...props} />);
