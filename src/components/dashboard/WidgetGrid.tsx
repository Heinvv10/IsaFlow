/**
 * WidgetGrid — Responsive 3-column grid that renders configured widgets.
 * // WORKING: Edit mode, add/remove widgets, reset to default layout.
 */

import { useState, useCallback } from 'react';
import { Plus, RotateCcw, GripVertical, X } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  type WidgetConfig,
  type WidgetType,
  WIDGET_SIZE_CLASS,
  WIDGET_CATALOGUE,
  DEFAULT_WIDGET_LAYOUT,
} from './widgetTypes';
import { BankSummaryWidget } from './widgets/BankSummaryWidget';
import { InvoicesOwedWidget } from './widgets/InvoicesOwedWidget';
import { BillsToPayWidget } from './widgets/BillsToPayWidget';
import { QuickActionsWidget } from './widgets/QuickActionsWidget';
import { RecentActivityWidget } from './widgets/RecentActivityWidget';
import { PnlSnapshotWidget } from './widgets/PnlSnapshotWidget';
import { VatSummaryWidget } from './widgets/VatSummaryWidget';

// ---------------------------------------------------------------------------
// Widget renderer
// ---------------------------------------------------------------------------

function renderWidget(type: WidgetType): React.ReactNode {
  switch (type) {
    case 'bank-summary':     return <BankSummaryWidget />;
    case 'invoices-owed':    return <InvoicesOwedWidget />;
    case 'bills-to-pay':     return <BillsToPayWidget />;
    case 'quick-actions':    return <QuickActionsWidget />;
    case 'recent-activity':  return <RecentActivityWidget />;
    case 'pnl-snapshot':     return <PnlSnapshotWidget />;
    case 'vat-summary':      return <VatSummaryWidget />;
    default:
      return (
        <Card>
          <p className="text-sm text-gray-500 dark:text-gray-400 capitalize">
            {type.replace(/-/g, ' ')} widget coming soon.
          </p>
        </Card>
      );
  }
}

// ---------------------------------------------------------------------------
// Add Widget Modal
// ---------------------------------------------------------------------------

interface AddWidgetModalProps {
  onAdd: (type: WidgetType, size: WidgetConfig['size']) => void;
  onClose: () => void;
  existingTypes: WidgetType[];
}

function AddWidgetModal({ onAdd, onClose, existingTypes }: AddWidgetModalProps) {
  const available = WIDGET_CATALOGUE.filter(w => !existingTypes.includes(w.type));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div className="relative z-10 w-full max-w-md mx-4 bg-white dark:bg-gray-900 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Add Widget</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {available.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">All available widgets are already on your dashboard.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {available.map(w => (
              <button
                key={w.type}
                onClick={() => { onAdd(w.type, w.size); onClose(); }}
                className="flex flex-col items-start gap-1 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-teal-400 dark:hover:border-teal-500 hover:bg-teal-50 dark:hover:bg-teal-900/20 transition-colors text-left"
              >
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{w.title}</span>
                <span className="text-xs text-gray-500 dark:text-gray-400 capitalize">{w.size} size</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WidgetGrid
// ---------------------------------------------------------------------------

interface WidgetGridProps {
  widgets: WidgetConfig[];
  editMode: boolean;
  onLayoutChange: (widgets: WidgetConfig[]) => void;
}

export function WidgetGrid({ widgets, editMode, onLayoutChange }: WidgetGridProps) {
  const [showAddModal, setShowAddModal] = useState(false);

  const handleRemove = useCallback((id: string) => {
    onLayoutChange(widgets.filter(w => w.id !== id));
  }, [widgets, onLayoutChange]);

  const handleAdd = useCallback((type: WidgetType, size: WidgetConfig['size']) => {
    const newWidget: WidgetConfig = {
      id: `${type}-${Date.now()}`,
      type,
      title: WIDGET_CATALOGUE.find(w => w.type === type)?.title ?? type,
      size,
    };
    onLayoutChange([...widgets, newWidget]);
  }, [widgets, onLayoutChange]);

  const handleReset = useCallback(() => {
    onLayoutChange(DEFAULT_WIDGET_LAYOUT);
  }, [onLayoutChange]);

  const existingTypes = widgets.map(w => w.type);

  return (
    <div className="space-y-4">
      {/* Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {widgets.map(widget => (
          <div
            key={widget.id}
            className={`relative ${WIDGET_SIZE_CLASS[widget.size]}`}
          >
            {/* Drag handle (visual only) */}
            {editMode && (
              <div className="absolute top-2 left-2 z-10 p-1 rounded cursor-grab text-gray-400 dark:text-gray-500">
                <GripVertical className="h-4 w-4" />
              </div>
            )}
            {/* Remove button */}
            {editMode && (
              <button
                onClick={() => handleRemove(widget.id)}
                className="absolute top-2 right-2 z-10 p-1 rounded-full bg-red-100 dark:bg-red-900/30 text-red-500 hover:bg-red-200 dark:hover:bg-red-900/60 transition-colors"
                aria-label={`Remove ${widget.title} widget`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            {/* Widget content */}
            <div className={editMode ? 'opacity-80 pointer-events-none select-none' : ''}>
              {renderWidget(widget.type)}
            </div>
          </div>
        ))}

        {/* Add Widget button in edit mode */}
        {editMode && (
          <div className="col-span-1">
            <button
              onClick={() => setShowAddModal(true)}
              className="w-full h-full min-h-[120px] flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 hover:border-teal-400 dark:hover:border-teal-500 hover:bg-teal-50 dark:hover:bg-teal-900/10 transition-colors text-gray-400 dark:text-gray-500 hover:text-teal-600 dark:hover:text-teal-400"
            >
              <Plus className="h-6 w-6" />
              <span className="text-sm font-medium">Add Widget</span>
            </button>
          </div>
        )}
      </div>

      {/* Edit mode controls */}
      {editMode && (
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReset}
            className="flex items-center gap-1.5"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset to Suggested
          </Button>
        </div>
      )}

      {/* Add Widget Modal */}
      {showAddModal && (
        <AddWidgetModal
          onAdd={handleAdd}
          onClose={() => setShowAddModal(false)}
          existingTypes={existingTypes}
        />
      )}
    </div>
  );
}
