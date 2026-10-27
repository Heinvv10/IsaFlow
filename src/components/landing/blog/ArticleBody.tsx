/**
 * The rendered MDX body. The HTML was produced on the server from repo-reviewed MDX
 * (src/lib/blog/renderMdx.tsx); no MDX runs in the browser. Typography for plain Markdown
 * elements lives here as child selectors (the repo has no typography plugin); the MDX
 * components and GFM tables style themselves.
 */
const PROSE = [
  'text-lg leading-8 text-slate-700',
  '[&>p]:my-6 [&>ul]:my-6 [&>ol]:my-6 [&>blockquote]:my-8 [&>pre]:my-8 [&>:first-child]:mt-0',
  '[&_h2]:mt-14 [&_h2]:scroll-mt-28 [&_h2]:text-3xl [&_h2]:font-bold [&_h2]:tracking-tight [&_h2]:text-slate-900',
  '[&_h3]:mt-10 [&_h3]:scroll-mt-28 [&_h3]:text-2xl [&_h3]:font-semibold [&_h3]:text-slate-900',
  '[&_h4]:mt-8 [&_h4]:text-xl [&_h4]:font-semibold [&_h4]:text-slate-900',
  '[&_strong]:font-semibold [&_strong]:text-slate-900',
  '[&_a]:font-medium [&_a]:text-teal-700 [&_a]:underline [&_a]:decoration-teal-300 [&_a]:underline-offset-4 hover:[&_a]:decoration-teal-600',
  '[&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:mt-2 [&_li]:pl-1 [&_li::marker]:text-teal-600',
  '[&_ul.contains-task-list]:list-none [&_ul.contains-task-list]:pl-0 [&_li.task-list-item]:flex [&_li.task-list-item]:items-start [&_li.task-list-item]:gap-3',
  '[&_input[type=checkbox]]:mt-2 [&_input[type=checkbox]]:h-4 [&_input[type=checkbox]]:w-4 [&_input[type=checkbox]]:accent-teal-600',
  '[&_del]:text-slate-600',
  '[&_blockquote]:border-l-4 [&_blockquote]:border-teal-500 [&_blockquote]:pl-6 [&_blockquote]:italic [&_blockquote]:text-slate-700',
  '[&_hr]:my-12 [&_hr]:border-slate-200',
  '[&_:not(pre)>code]:rounded-md [&_:not(pre)>code]:bg-slate-100 [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:text-base [&_:not(pre)>code]:text-slate-900',
  '[&_pre]:overflow-x-auto [&_pre]:rounded-2xl [&_pre]:bg-[#0b1220] [&_pre]:p-5 [&_pre]:text-sm [&_pre]:leading-6 [&_pre]:text-slate-100',
  '[&_img]:rounded-2xl',
].join(' ');

export function ArticleBody({ html }: { html: string }) {
  return <div className={PROSE} dangerouslySetInnerHTML={{ __html: html }} />;
}
