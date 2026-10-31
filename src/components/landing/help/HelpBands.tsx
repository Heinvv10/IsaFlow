import { Breadcrumb } from '@/components/landing/blog/BlogShell';
import { HELP_DESCRIPTION } from '@/lib/help/constants';
import type { HelpFrontmatter } from '@/lib/help/content';

export function HelpIndexBand() {
  return (
    <>
      <Breadcrumb trail={[{ name: 'Home', href: '/' }, { name: 'Help' }]} />
      <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-teal-400">ISAFlow Help</p>
      <h1 className="max-w-3xl text-4xl font-extrabold tracking-tight sm:text-5xl">Help centre</h1>
      <p className="mt-5 max-w-2xl text-lg text-white/70">{HELP_DESCRIPTION}</p>
    </>
  );
}

export function HelpArticleBand({ document }: { document: HelpFrontmatter }) {
  return (
    <div className="max-w-3xl">
      <Breadcrumb trail={[
        { name: 'Home', href: '/' },
        { name: 'Help', href: '/help' },
        { name: document.title },
      ]} />
      <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">{document.title}</h1>
      <p className="mt-5 text-lg text-white/70">{document.description}</p>
      <p className="mt-6 text-sm text-white/70">
        Updated <time dateTime={document.updated}>{document.updated}</time>
      </p>
    </div>
  );
}
