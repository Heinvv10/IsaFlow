/**
 * Components available inside blog MDX. Rendered to static HTML at build/ISR time
 * (src/lib/blog/renderMdx.tsx), so nothing here ships as client JS.
 */
import type { ComponentPropsWithoutRef } from 'react';
import { Callout } from './Callout';
import { Chart } from './Chart';
import { Figure, Screenshot } from './Figure';

/**
 * GFM tables: horizontal scroll on narrow screens, a styled header row, row borders with
 * zebra striping and tabular figures. GFM column alignment (|--:|) arrives as an inline
 * text-align style on each cell, which wins over the default left alignment.
 */
const TABLE_CLASSES = [
  'w-full min-w-[32rem] border-collapse text-left text-sm text-slate-700',
  '[&_thead]:bg-slate-900 [&_th]:px-4 [&_th]:py-3 [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-white',
  '[&_td]:border-t [&_td]:border-slate-200 [&_td]:px-4 [&_td]:py-3 [&_td]:align-top [&_td]:tabular-nums',
  '[&_tbody_tr:nth-child(even)]:bg-slate-50 [&_tbody_tr:hover]:bg-teal-50/60',
].join(' ');

function Table(props: ComponentPropsWithoutRef<'table'>) {
  return (
    <div className="blog-table my-8 overflow-x-auto rounded-2xl border border-slate-200 shadow-sm" role="region" aria-label="Table" tabIndex={0}>
      <table className={TABLE_CLASSES} {...props} />
    </div>
  );
}

const SITE_LINK = /^https:\/\/isaflow\.co\.za(?:[/?#]|$)/;

function Anchor(props: ComponentPropsWithoutRef<'a'>) {
  const external = typeof props.href === 'string' && /^https?:\/\//.test(props.href) && !SITE_LINK.test(props.href);
  return <a {...props} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})} />;
}

export const blogMdxComponents = {
  Chart,
  Screenshot,
  Figure,
  Callout,
  table: Table,
  a: Anchor,
};
