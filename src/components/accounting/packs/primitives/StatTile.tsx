/**
 * One key-statistic tile — page 12's stats strip (`PackStatGroup.stats`).
 * Deliberately plainer than `KpiTileWithSparkline`: no delta, no sparkline,
 * because a `PackStatItem` carries neither — this is a label and a figure,
 * nothing this component may add.
 */
import { formatFigureText } from './packFigureText';
import type { PackStatItem } from '@/modules/accounting/services/packs/pages/packPageModel';

export interface StatTileProps {
  stat: PackStatItem;
}

export function StatTile({ stat }: StatTileProps) {
  return (
    <div className="pack-stat-tile">
      <span className="pack-stat-label">{stat.label}</span>
      <span className={stat.figure.value === null ? 'pack-stat-value is-unavailable' : 'pack-stat-value'}>
        {formatFigureText(stat.figure)}
      </span>
    </div>
  );
}
