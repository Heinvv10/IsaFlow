/**
 * Components available inside blog MDX. Rendered to static HTML at build/ISR time
 * (src/lib/blog/renderMdx.tsx), so nothing here ships as client JS.
 */
import { Children, cloneElement, isValidElement, type ComponentPropsWithoutRef } from 'react';
import { Callout } from './Callout';
import { Chart } from './Chart';
import { Figure, Screenshot } from './Figure';

/**
 * GFM tables size to their content (w-full fills the column when they fit; cells wrap first) and
 * scroll sideways only when they cannot fit, with a right-edge fade while more columns are hidden
 * (`.blog-table` in styles/globals.css). Styled header row, row borders with zebra striping and
 * tabular figures. GFM column alignment (|--:|) arrives as an inline text-align style on each cell,
 * which wins over the default left alignment.
 */
const TABLE_CLASSES = [
  'w-full border-collapse text-left text-sm text-slate-700',
  '[&_thead]:bg-slate-900 [&_th]:px-3 [&_th]:py-3 sm:[&_th]:px-4 [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-white',
  '[&_td]:border-t [&_td]:border-slate-200 [&_td]:px-3 [&_td]:py-3 sm:[&_td]:px-4 [&_td]:align-top [&_td]:tabular-nums',
  '[&_td]:bg-white [&_tbody_tr:nth-child(even)_td]:bg-slate-50 [&_tbody_tr:hover_td]:bg-teal-50/60',
].join(' ');

function Table(props: ComponentPropsWithoutRef<'table'>) {
  return (
    <div className="blog-table my-8 overflow-x-auto rounded-2xl border border-slate-200 shadow-sm" role="region" aria-label="Table" tabIndex={0}>
      <table className={TABLE_CLASSES} {...props} />
    </div>
  );
}

type ImageProps = ComponentPropsWithoutRef<'img'> & { linked?: boolean };

/**
 * A Markdown image (`![alt](src)`): a link to the full-size file in a new tab, so a wide image
 * shrunk to a phone's width can be opened and zoomed. An image the author already linked
 * (`[![alt](src)](href)`) arrives with `linked` from Anchor and renders bare. JSX <img>,
 * <Screenshot> and <Chart> never reach this component.
 */
function ArticleImage({ linked, src, alt = '', ...rest }: ImageProps) {
  const img = <img {...rest} src={src} alt={alt} loading="lazy" decoding="async" className="rounded-2xl" />;
  if (linked || typeof src !== 'string' || !src) return img;
  const label = alt ? `Open full-size image: ${alt} (opens in new tab)` : 'Open full-size image (opens in new tab)';
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" aria-label={label} className="ff-focus-ring inline-block max-w-full rounded-2xl align-top">
      {img}
      <span aria-hidden="true" className="mt-2 block text-center text-sm sm:hidden">
        Tap to open full size
      </span>
    </a>
  );
}

const SITE_LINK = /^https:\/\/isaflow\.co\.za(?:[/?#]|$)/;

function Anchor(props: ComponentPropsWithoutRef<'a'>) {
  const external = typeof props.href === 'string' && /^https?:\/\//.test(props.href) && !SITE_LINK.test(props.href);
  const children = Children.map(props.children, (c) => (isValidElement<ImageProps>(c) && c.type === ArticleImage ? cloneElement(c, { linked: true }) : c));
  return <a {...props} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{children}</a>;
}

export const blogMdxComponents = {
  Chart,
  Screenshot,
  Figure,
  Callout,
  table: Table,
  a: Anchor,
  img: ArticleImage,
};
