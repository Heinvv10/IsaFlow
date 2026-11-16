/**
 * UDF Tab — User Defined Fields configuration
 * Shows 4 entity-type sections; each has 12 UDF slots configurable by label/type/required/active.
 */

import { SECTION_CLS } from './settingsTypes';
import { ENTITY_SECTIONS } from './udfTypes';
import { EntitySection } from './UdfEntitySection';

// ── Main export ───────────────────────────────────────────────────────────────

export function UdfTab() {
  return (
    <div className="space-y-4">
      <div className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-1">User Defined Fields</h2>
        <p className="text-sm text-[var(--ff-text-secondary)]">
          Add up to 12 custom fields to each entity type. Fields appear on the entity edit form
          and can be used in custom reports.
        </p>
      </div>

      {ENTITY_SECTIONS.map(s => (
        <EntitySection key={s.type} entityType={s.type} label={s.label} />
      ))}
    </div>
  );
}
