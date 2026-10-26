/**
 * Pixel heights of the app shell's fixed bars. AppLayout pins its nav slots to these and ShellSkeleton draws the
 * same bars while the session check runs, so the page content starts at the same y before and after: no layout
 * shift when the shell arrives. ModuleNav's row is 43px (py-2.5 + a 2px tab border + its 1px bottom border); the
 * module nav adds its own 1px border.
 */
export const SHELL_HEIGHTS = { header: 56, topNav: 43, moduleNav: 44 } as const;
