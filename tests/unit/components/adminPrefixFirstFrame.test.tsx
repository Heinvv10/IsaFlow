/**
 * #1373 review L6: useAdminPrefix read the host in an effect, so on admin.isaflow.co.za the first frame of every
 * admin link (desktop menu, drawer, palette) pointed at /admin/*, which the admin host rewrites to /admin/admin/*.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { useAdminHref } from '@/hooks/useAdminPrefix';

const START_URL = window.location.href;
const onHost = (url: string) => (window as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(url);

function Probe({ seen }: { seen: string[] }) {
  seen.push(useAdminHref()('/admin/companies'));
  return null;
}

afterEach(() => { cleanup(); onHost(START_URL); });

describe('useAdminHref on its first render', () => {
  it('on the admin host the very first href is already the clean path', () => {
    onHost('https://admin.isaflow.co.za/');
    const seen: string[] = [];
    render(<Probe seen={seen} />);
    expect(seen[0]).toBe('/companies');
    expect(new Set(seen)).toEqual(new Set(['/companies']));
  });

  it('anywhere else it keeps the /admin prefix', () => {
    onHost('http://localhost:3200/admin');
    const seen: string[] = [];
    render(<Probe seen={seen} />);
    expect(new Set(seen)).toEqual(new Set(['/admin/companies']));
  });
});
