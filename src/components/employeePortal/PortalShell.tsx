/** The employee portal's page frame (wave 6 SS): no staff navigation, both themes, phone width first. */
import type { ReactNode } from 'react';
import Head from 'next/head';

export function PortalShell({ title, employer, actions, children }: { title: string; employer?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <>
      <Head>
        <title>{`${title} - IsaFlow employee portal`}</title>
        <meta name="robots" content="noindex" />
      </Head>
      <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
        <header className="border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-teal-700 dark:text-teal-400">IsaFlow employee portal</p>
              {employer && <p className="truncate text-sm text-gray-600 dark:text-gray-300">{employer}</p>}
            </div>
            {actions}
          </div>
        </header>
        <main className="mx-auto max-w-3xl px-4 py-6">
          <h1 className="mb-4 text-xl font-semibold">{title}</h1>
          {children}
        </main>
      </div>
    </>
  );
}
