/**
 * A section-divider page — a full page carrying only the next section's
 * name, so a reader flipping the printed pack can find "Financials" without
 * reading a running header. Its own `.pack-page`/`break-after` frame comes
 * from `PackPageFrame`, same as every other page; this component is only
 * the centred content a divider page's `children` slot receives.
 */
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';

export interface SectionDividerProps {
  section: PackPage['section'];
  title: string;
}

export function SectionDivider({ section, title }: SectionDividerProps) {
  return (
    <div className="pack-section-divider">
      <span className="pack-section-divider-eyebrow">{section}</span>
      <h2 className="pack-section-divider-title">{title}</h2>
    </div>
  );
}
