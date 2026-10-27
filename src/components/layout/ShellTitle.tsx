/**
 * ShellTitle — the fallback document title, "Tax Invoices · Sales · IsaFlow" (shellRoutes.documentTitle). A page's
 * own <Head><title> always wins over it.
 *
 * next/head keeps one ordered list of mounted <Head>s and the LAST title in it wins; a Head moves to the end of the
 * list whenever it mounts or re-renders. So this one is rendered by _app, before the page, where it mounts once and
 * never remounts (AppLayout swapping its skeleton for the shell would remount anything inside it), and it is
 * memoised on the string, so it re-renders only when the title itself changes. A page's Head - inside AppLayout or
 * before it - is always later in the list.
 */
import { memo, useMemo } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { TABS } from '@/components/accounting/accountingNavConfig';
import { buildNavIndex } from '@/components/accounting/navSections/navIndex';
import { useVatRegistration } from '@/hooks/useVatRegistration';
import { documentTitle } from '@/components/layout/shellRoutes';

const TitleHead = memo(function TitleHead({ title }: { title: string }) {
  return <Head><title>{title}</title></Head>;
});

export function ShellTitle() {
  const router = useRouter();
  const { isRegistered } = useVatRegistration();
  const navIndex = useMemo(() => buildNavIndex(TABS, isRegistered), [isRegistered]);
  return <TitleHead title={documentTitle(router.asPath, navIndex)} />;
}
