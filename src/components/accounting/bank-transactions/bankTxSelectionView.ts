/** The page's selection against what is on screen (WP3): a row that is no longer listed is not selected. */

/** The ids of `selected` that are among `onScreen`'s rows - the only ones a bulk action may touch. */
export function selectedOnScreen(selected: ReadonlySet<string>, onScreen: ReadonlyArray<{ id: string }>): Set<string> {
  const visible = new Set(onScreen.map(t => t.id));
  return new Set([...selected].filter(id => visible.has(id)));
}

/** The same set, or null when nothing needs pruning (so a state setter can return `prev` and skip a render). */
export function pruneSelection(selected: ReadonlySet<string>, onScreen: ReadonlyArray<{ id: string }>): Set<string> | null {
  const kept = selectedOnScreen(selected, onScreen);
  return kept.size === selected.size ? null : kept;
}
