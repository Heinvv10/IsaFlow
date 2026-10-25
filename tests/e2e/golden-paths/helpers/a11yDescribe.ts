/**
 * The selector a baseline entry is keyed by: where a node sits, said in terms that survive a rebuild and a data
 * change - the nearest anchor (a stable id, data-testid, landmark or form) and the tags/names between it and the
 * node, plus the visible text of a short leaf (a button, a link, a label, a note; never a span: badges and amounts are data) outside table/list rows. No classes
 * (utility classes churn), no :nth-child (rows come and go), no generated ids, no values; digits become '#'.
 *
 * `describeTargets` runs INSIDE the page (Playwright serialises it), so it must stay self-contained: nothing it
 * uses may be imported or defined outside it. It is unit-tested under happy-dom.
 */

/** Context selector for each axe target, in order; a target that is not a single resolvable selector is returned as axe wrote it. */
export function describeTargets(targets: string[][]): string[] {
  const GENERATED_ID = /^(:r|radix|headlessui|react|rc[-_]|ember|mui)|\d{4,}|[0-9a-f]{8}-[0-9a-f]{4}-/i;
  const STABLE_ID = /^[A-Za-z][\w-]*$/;
  const LANDMARKS = ['main', 'nav', 'header', 'aside', 'footer', 'form', 'dialog', 'table', 'section'];
  const ROLE_ANCHORS = ['main', 'navigation', 'banner', 'complementary', 'dialog', 'alertdialog', 'form', 'region', 'tablist', 'listbox'];
  const MAX_DEPTH = 6;
  const TEXT_TAGS = ['button', 'a', 'label', 'p', 'th', 'legend', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
  const DATA_REGION = 'tbody, li, [role="row"], [role="listitem"], [role="option"]';

  const idOf = (e: Element): string => {
    const id = e.getAttribute('id');
    return id && STABLE_ID.test(id) && !GENERATED_ID.test(id) ? id : '';
  };
  const hrefOf = (e: Element): string => {
    const href = e.getAttribute('href');
    if (!href || href.startsWith('javascript:')) return '';
    return href.split(/[?#]/)[0]!.split('/').map((s) => (/^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) ? ':id' : s)).join('/');
  };
  const segment = (e: Element): string => {
    const tag = e.tagName.toLowerCase();
    let s = tag;
    const id = idOf(e);
    if (id) s += `#${id}`;
    const attr = (name: string, value: string | null) => { if (value) s += `[${name}="${value.replace(/"/g, "'").slice(0, 40)}"]`; };
    attr('data-testid', e.getAttribute('data-testid'));
    attr('name', e.getAttribute('name'));
    if (tag === 'input' || tag === 'button') attr('type', e.getAttribute('type'));
    attr('role', e.getAttribute('role'));
    attr('aria-label', e.getAttribute('aria-label')?.replace(/\d+/g, '#') ?? null);
    attr('href', hrefOf(e));
    attr('for', e.getAttribute('for'));
    // Copy is stable, row data is not: name a leaf by its text only outside table and list rows.
    const text = (e.textContent ?? '').replace(/\s+/g, ' ').trim().replace(/\d+/g, '#');
    if (TEXT_TAGS.includes(tag) && e.children.length === 0 && text.length > 0 && text.length <= 30 && !e.closest(DATA_REGION)) s += `{${text}}`;
    return s;
  };
  // A named container (a list, a section, a div with an aria-label) is as good an anchor as a landmark; a named
  // control (a button's own aria-label) is the node itself, not a place to stop climbing.
  const NAMEABLE_CONTAINERS = ['ul', 'ol', 'section', 'div', 'table', 'fieldset'];
  const isAnchor = (e: Element): boolean =>
    e.tagName.toLowerCase() === 'html' || idOf(e) !== '' || e.hasAttribute('data-testid') || LANDMARKS.includes(e.tagName.toLowerCase())
    || ROLE_ANCHORS.includes(e.getAttribute('role') ?? '')
    || (e.hasAttribute('aria-label') && NAMEABLE_CONTAINERS.includes(e.tagName.toLowerCase()));

  return targets.map((target) => {
    const fallback = target.join(' >> ');
    if (target.length !== 1) return fallback;
    let node: Element | null = null;
    try { node = document.querySelector(target[0]!); } catch { return fallback; }
    if (!node) return fallback;
    const chain: string[] = [];
    let cur: Element | null = node;
    for (let depth = 0; cur && depth < MAX_DEPTH; depth++) {
      chain.unshift(segment(cur));
      if (isAnchor(cur) || cur === document.body) break;
      cur = cur.parentElement;
    }
    return chain.join(' > ');
  });
}
