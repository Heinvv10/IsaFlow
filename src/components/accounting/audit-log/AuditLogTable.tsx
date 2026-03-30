/**
 * Audit Log Table Component
 * Renders the audit log rows with expandable field-change details.
 */

import Link from 'next/link';
import { ChevronDown, ChevronRight, Shield } from 'lucide-react';
import type { AuditLogItem, AuditAction } from '@/modules/accounting/services/auditTrailService';

export const ACTION_LABELS: Record<AuditAction, string> = {
  create: 'Created',
  update: 'Updated',
  delete: 'Deleted',
  post: 'Posted',
  reverse: 'Reversed',
  approve: 'Approved',
  reject: 'Rejected',
  login: 'Login',
  export: 'Exported',
};

const ACTION_COLORS: Record<AuditAction, string> = {
  create: 'bg-green-500/10 text-green-400 border-green-500/20',
  update: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  delete: 'bg-red-500/10 text-red-400 border-red-500/20',
  post: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
  reverse: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  approve: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  reject: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
  login: 'bg-gray-500/10 text-gray-400 border-gray-500/20',
  export: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
};

const ENTITY_ROUTE_MAP: Record<string, string> = {
  invoice: '/accounting/customer-invoices',
  customer_invoice: '/accounting/customer-invoices',
  supplier_invoice: '/accounting/supplier-invoices',
  customer: '/accounting/customers',
  supplier: '/accounting/suppliers',
  journal_entry: '/accounting/journal-entries',
  payment: '/accounting/customer-payments',
  supplier_payment: '/accounting/supplier-payments',
  purchase_order: '/accounting/purchase-orders',
  bank_account: '/accounting/bank-accounts',
  asset: '/accounting/assets',
  budget: '/accounting/budgets',
};

function entityRoute(entityType: string, entityId: string): string | null {
  const base = ENTITY_ROUTE_MAP[entityType.toLowerCase()];
  return base ? `${base}/${entityId}` : null;
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-ZA', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return iso;
  }
}

interface Props {
  items: AuditLogItem[];
  expandedRows: Set<string>;
  onToggleRow: (id: string) => void;
}

export function AuditLogTable({ items, expandedRows, onToggleRow }: Props) {
  if (items.length === 0) {
    return (
      <div className="text-center py-16">
        <Shield className="h-10 w-10 text-[var(--ff-text-secondary)] mx-auto mb-3 opacity-40" />
        <p className="text-[var(--ff-text-secondary)] text-sm">No audit records found</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)]/50">
            <th className="w-8 px-4 py-3" />
            {['Date / Time', 'User', 'Action', 'Entity Type', 'Reference', 'Changes', 'IP Address'].map(h => (
              <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--ff-border-light)]">
          {items.map(item => {
            const isExpanded = expandedRows.has(item.id);
            const hasChanges = (item.changes?.fields?.length ?? 0) > 0;
            const route = entityRoute(item.entityType, item.entityId);

            return (
              <>
                <tr key={item.id} className="hover:bg-[var(--ff-bg-primary)]/40 transition-colors">
                  <td className="px-4 py-3">
                    {hasChanges && (
                      <button
                        onClick={() => onToggleRow(item.id)}
                        className="text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors"
                        aria-label={isExpanded ? 'Collapse' : 'Expand'}
                      >
                        {isExpanded
                          ? <ChevronDown className="h-4 w-4" />
                          : <ChevronRight className="h-4 w-4" />}
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3 text-[var(--ff-text-secondary)] whitespace-nowrap font-mono text-xs">
                    {formatDateTime(item.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-[var(--ff-text-primary)]">
                    {item.userEmail ?? item.userId}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium ${ACTION_COLORS[item.action] ?? 'bg-gray-500/10 text-gray-400 border-gray-500/20'}`}>
                      {ACTION_LABELS[item.action] ?? item.action}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
                    {item.entityType.replace(/_/g, ' ')}
                  </td>
                  <td className="px-4 py-3">
                    {item.entityRef && route ? (
                      <Link href={route} className="text-teal-400 hover:text-teal-300 hover:underline font-mono text-xs">
                        {item.entityRef}
                      </Link>
                    ) : (
                      <span className="text-[var(--ff-text-secondary)] font-mono text-xs">
                        {item.entityRef ?? item.entityId.slice(0, 8) + '...'}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-[var(--ff-text-secondary)] text-xs">
                    {hasChanges ? `${item.changes!.fields.length} field${item.changes!.fields.length !== 1 ? 's' : ''} changed` : '—'}
                  </td>
                  <td className="px-4 py-3 text-[var(--ff-text-secondary)] font-mono text-xs">
                    {item.ipAddress ?? '—'}
                  </td>
                </tr>

                {isExpanded && hasChanges && (
                  <tr key={`${item.id}-detail`} className="bg-[var(--ff-bg-primary)]/20">
                    <td colSpan={8} className="px-8 py-4">
                      <div className="rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-[var(--ff-bg-primary)]/60">
                              {['Field', 'Before', 'After'].map(h => (
                                <th key={h} className="px-4 py-2 text-left text-[var(--ff-text-secondary)] font-semibold uppercase tracking-wider">
                                  {h}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[var(--ff-border-light)]">
                            {item.changes!.fields.map((f, idx) => (
                              <tr key={idx} className="hover:bg-[var(--ff-bg-secondary)]/40">
                                <td className="px-4 py-2 font-medium text-[var(--ff-text-primary)] w-1/4">{f.label}</td>
                                <td className="px-4 py-2 text-red-400/80 w-1/3">{f.old ?? <span className="italic opacity-50">empty</span>}</td>
                                <td className="px-4 py-2 text-green-400/80 w-1/3">{f.new ?? <span className="italic opacity-50">empty</span>}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {item.changes!.metadata && Object.keys(item.changes!.metadata).length > 0 && (
                          <div className="px-4 py-2 bg-[var(--ff-bg-primary)]/30 border-t border-[var(--ff-border-light)] flex flex-wrap gap-3">
                            {Object.entries(item.changes!.metadata).map(([k, v]) => (
                              <span key={k} className="text-[var(--ff-text-secondary)] text-xs">
                                <span className="font-medium">{k}:</span> {v}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
