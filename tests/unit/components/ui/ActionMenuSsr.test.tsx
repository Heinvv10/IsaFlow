// @vitest-environment node
/**
 * ActionMenu renders on the server (a page's first HTML) without React's "useLayoutEffect does nothing on the server"
 * warning: its width measurement is an isomorphic layout effect (useEffect where there is no window).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ActionMenu } from '@/components/ui/ActionMenu';

vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
afterEach(() => { vi.restoreAllMocks(); });

describe('ActionMenu on the server', () => {
  it('renders the trigger, with no layout-effect warning', () => {
    expect(typeof window).toBe('undefined');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const html = renderToString(<ActionMenu triggerLabel="Row actions" items={[{ label: 'A', onClick: () => undefined }]} />);
    expect(html).toContain('aria-label="Row actions"');
    expect(error.mock.calls.map(c => String(c[0])).filter(m => m.includes('useLayoutEffect'))).toEqual([]);
  });
});
