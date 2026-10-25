/**
 * The label style of the report filter bars (`<label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">`),
 * for a kit control that sits among them. `Select` merges this over its own label classes with tailwind-merge, which
 * keeps a `dark:` colour the override does not restate - hence the explicit dark variant: without it the label is
 * tertiary text in light mode and gray-300 in dark mode.
 */
export const REPORT_FILTER_LABEL_CLASS = 'block text-xs font-normal mb-1 text-[var(--ff-text-tertiary)] dark:text-[var(--ff-text-tertiary)]';
