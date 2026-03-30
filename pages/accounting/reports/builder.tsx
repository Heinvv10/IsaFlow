/**
 * Custom Report Builder Page — WS-7.1
 * Left sidebar: data source + fields | Center: preview table | Top: actions
 */

import { useState, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { ReportBuilderSidebar } from '@/components/accounting/reports/ReportBuilderSidebar';
import { ReportBuilderFilters, type FilterRow } from '@/components/accounting/reports/ReportBuilderFilters';
import { ReportBuilderPreview } from '@/components/accounting/reports/ReportBuilderPreview';
import { Play, Save, Download, ChevronLeft, BookOpen } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import Link from 'next/link';
import { useRouter } from 'next/router';

interface FieldDef {
  field: string;
  label: string;
  type: string;
  filterable: boolean;
}

interface Column {
  field: string;
  label: string;
  type: string;
}

interface SortState {
  field: string;
  direction: 'asc' | 'desc';
}

interface RunResult {
  columns: Column[];
  rows: Array<Record<string, unknown>>;
  totals: Record<string, number>;
  rowCount: number;
}

export default function ReportBuilderPage() {
  const router = useRouter();
  const [dataSource, setDataSource] = useState('');
  const [availableFields, setAvailableFields] = useState<FieldDef[]>([]);
  const [columns, setColumns] = useState<Column[]>([]);
  const [filters, setFilters] = useState<FilterRow[]>([]);
  const [sort, setSort] = useState<SortState[]>([]);
  const [result, setResult] = useState<RunResult>({ columns: [], rows: [], totals: {}, rowCount: 0 });
  const [isRunning, setIsRunning] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [reportName, setReportName] = useState('Untitled Report');
  const [toast, setToast] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  }

  function handleSourceChange(source: string) {
    setDataSource(source);
    setColumns([]);
    setFilters([]);
    setSort([]);
    setResult({ columns: [], rows: [], totals: {}, rowCount: 0 });
    if (source) {
      apiFetch(`/api/accounting/custom-reports-fields?source=${source}`, { credentials: 'include' })
        .then(r => r.json())
        .then(json => setAvailableFields(json.data?.fields ?? []))
        .catch(() => setAvailableFields([]));
    } else {
      setAvailableFields([]);
    }
  }

  function handleAddField(field: FieldDef) {
    if (columns.find(c => c.field === field.field)) return;
    setColumns(prev => [...prev, { field: field.field, label: field.label, type: field.type }]);
  }

  function handleRemoveColumn(field: string) {
    setColumns(prev => prev.filter(c => c.field !== field));
    setSort(prev => prev.filter(s => s.field !== field));
  }

  function handleSortChange(field: string) {
    setSort(prev => {
      const existing = prev.find(s => s.field === field);
      if (!existing) return [...prev, { field, direction: 'asc' }];
      if (existing.direction === 'asc') return prev.map(s => s.field === field ? { ...s, direction: 'desc' } : s);
      return prev.filter(s => s.field !== field);
    });
  }

  const handleRun = useCallback(async () => {
    if (!dataSource || columns.length === 0) {
      showToast('Select a data source and at least one column');
      return;
    }
    setIsRunning(true);
    try {
      const body = {
        dataSource,
        columns: columns.map(c => ({ field: c.field, label: c.label })),
        filters: filters.map(f => ({
          field: f.field, operator: f.operator,
          value: f.value || undefined, value2: f.value2 || undefined,
        })).filter(f => f.field),
        sortBy: sort,
        limit: 500,
        offset: 0,
      };
      const res = await apiFetch('/api/accounting/custom-reports-run', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) { showToast(json.message || 'Run failed'); return; }
      setResult(json.data);
    } catch {
      showToast('Failed to run report');
    } finally {
      setIsRunning(false);
    }
  }, [dataSource, columns, filters, sort]);

  const handleSave = useCallback(async () => {
    if (!dataSource || columns.length === 0) {
      showToast('Configure the report before saving');
      return;
    }
    setIsSaving(true);
    try {
      const body = {
        name: reportName,
        dataSource,
        columns: columns.map(c => ({ field: c.field, label: c.label })),
        filters: filters.map(f => ({
          field: f.field, operator: f.operator,
          value: f.value || undefined, value2: f.value2 || undefined,
        })).filter(f => f.field),
        sortBy: sort,
      };
      const res = await apiFetch('/api/accounting/custom-reports', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) { showToast(json.message || 'Save failed'); return; }
      showToast('Report saved successfully');
      void router.replace(`/accounting/reports/builder?id=${json.data.id}`);
    } catch {
      showToast('Failed to save report');
    } finally {
      setIsSaving(false);
    }
  }, [dataSource, columns, filters, sort, reportName, router]);

  function handleExport() {
    if (!dataSource || columns.length === 0) {
      showToast('Configure the report before exporting');
      return;
    }
    const body = {
      dataSource,
      columns: columns.map(c => ({ field: c.field, label: c.label })),
      filters: filters.map(f => ({
        field: f.field, operator: f.operator,
        value: f.value || undefined, value2: f.value2 || undefined,
      })).filter(f => f.field),
      sortBy: sort,
      reportName,
    };
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/api/accounting/custom-reports-export';
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'body';
    input.value = JSON.stringify(body);
    form.appendChild(input);
    // Use fetch for authenticated download
    void apiFetch('/api/accounting/custom-reports-export', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async res => {
      if (!res.ok) { showToast('Export failed'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${reportName.replace(/[^a-z0-9_-]/gi, '_')}_${new Date().toISOString().split('T')[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }).catch(() => showToast('Export failed'));
    void form;
  }

  return (
    <AppLayout>
      <div className="flex flex-col h-full" style={{ height: 'calc(100vh - 64px)' }}>
        {/* Top bar */}
        <div className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200 shrink-0">
          <Link href="/accounting/reports/my-reports" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 transition-colors">
            <ChevronLeft className="w-4 h-4" />
            My Reports
          </Link>
          <div className="w-px h-5 bg-gray-200" />
          <BookOpen className="w-5 h-5 text-indigo-600" />
          <input
            type="text"
            value={reportName}
            onChange={e => setReportName(e.target.value)}
            className="text-base font-semibold text-gray-800 bg-transparent border-b border-transparent hover:border-gray-300 focus:border-indigo-500 focus:outline-none px-1 py-0.5 transition-colors w-64"
            placeholder="Report name..."
          />

          <div className="flex-1" />

          <button
            onClick={() => setSidebarOpen(o => !o)}
            className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded transition-colors"
          >
            {sidebarOpen ? 'Hide Sidebar' : 'Show Sidebar'}
          </button>

          <button
            onClick={handleRun}
            disabled={isRunning || !dataSource || columns.length === 0}
            className="flex items-center gap-2 px-4 py-1.5 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-40 transition-colors"
          >
            <Play className="w-4 h-4" />
            {isRunning ? 'Running...' : 'Run'}
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || !dataSource || columns.length === 0}
            className="flex items-center gap-2 px-4 py-1.5 bg-green-600 text-white text-sm font-medium rounded-md hover:bg-green-700 disabled:opacity-40 transition-colors"
          >
            <Save className="w-4 h-4" />
            {isSaving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={handleExport}
            disabled={!dataSource || columns.length === 0}
            className="flex items-center gap-2 px-4 py-1.5 bg-gray-600 text-white text-sm font-medium rounded-md hover:bg-gray-700 disabled:opacity-40 transition-colors"
          >
            <Download className="w-4 h-4" />
            Export CSV
          </button>
        </div>

        {/* Filter bar */}
        <ReportBuilderFilters
          filters={filters}
          availableFields={availableFields}
          onChange={setFilters}
        />

        {/* Main content area */}
        <div className="flex flex-1 min-h-0">
          {sidebarOpen && (
            <ReportBuilderSidebar
              selectedSource={dataSource}
              selectedFields={columns.map(c => c.field)}
              onSourceChange={handleSourceChange}
              onAddField={handleAddField}
            />
          )}
          <div className="flex-1 flex flex-col min-h-0 min-w-0">
            <ReportBuilderPreview
              columns={columns}
              rows={result.rows}
              totals={result.totals}
              rowCount={result.rowCount}
              sort={sort}
              isLoading={isRunning}
              onRemoveColumn={handleRemoveColumn}
              onSortChange={handleSortChange}
            />
          </div>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-gray-800 text-white text-sm px-4 py-2 rounded-lg shadow-lg animate-fade-in">
          {toast}
        </div>
      )}
    </AppLayout>
  );
}
