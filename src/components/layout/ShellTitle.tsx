/**
 * ShellTitle: the fallback document title, "Tax Invoices · Sales · IsaFlow" (shellRoutes.documentTitle over
 * pageRegistry.buildPageIndex). A page's own <Head><title> always wins over it.
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
import { buildPageIndex } from '@/components/accounting/navSections/pageRegistry';
import { useVatRegistration } from '@/hooks/useVatRegistration';
import { documentTitle, PRODUCT_TITLE } from '@/components/layout/shellRoutes';

const TitleHead = memo(function TitleHead({ title }: { title: string }) {
  return <Head><title>{title}</title></Head>;
});

export function ShellTitle() {
  const router = useRouter();
  const { isRegistered } = useVatRegistration();
  const pageIndex = useMemo(() => buildPageIndex(isRegistered), [isRegistered]);
  // The route pattern is the fallback for a visible URL the index does not know (the admin host can serve
  // /admin/* pages without the prefix: unverified, hence a fallback and not the first choice).
  const byUrl = documentTitle(router.asPath, pageIndex);
  const title = byUrl === PRODUCT_TITLE ? documentTitle(router.pathname, pageIndex) : byUrl;
  return <TitleHead title={title} />;
}
