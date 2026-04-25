import { useState, useEffect, useCallback } from 'react';
import { X, Folder, FileText, FileImage, File, ChevronRight, Loader2, AlertCircle, Home } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface SpFile { name: string; serverRelativeUrl: string; size: number; modified: string; }
interface SpFolder { name: string; serverRelativeUrl: string; itemCount: number; }
interface SpFolderContents { files: SpFile[]; folders: SpFolder[]; }
interface Breadcrumb { name: string; path: string; }

export interface SharePointPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (serverRelativeUrl: string, fileName: string) => Promise<void>;
  initialPath?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  try { return new Date(dateStr).toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return dateStr; }
}

function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return FileImage;
  if (ext === 'pdf') return FileText;
  return File;
}

function buildBreadcrumbs(path: string): Breadcrumb[] {
  const parts = path.split('/').filter(Boolean);
  const crumbs: Breadcrumb[] = [{ name: 'Home', path: 'Shared Documents' }];
  let cumulative = '';
  for (const part of parts) {
    cumulative = cumulative ? `${cumulative}/${part}` : part;
    if (cumulative !== 'Shared Documents') crumbs.push({ name: part, path: cumulative });
  }
  return crumbs;
}

export function SharePointPickerModal({ isOpen, onClose, onImport, initialPath = 'Shared Documents' }: SharePointPickerModalProps) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [contents, setContents] = useState<SpFolderContents | null>(null);
  const [loading, setLoading] = useState(false);
  const [importingUrl, setImportingUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const breadcrumbs = buildBreadcrumbs(currentPath);

  const fetchContents = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/accounting/sharepoint/browse?path=${encodeURIComponent(path)}`);
      const json = await res.json() as { success: boolean; data: SpFolderContents; error?: { message: string } };
      if (!res.ok || !json.success) throw new Error(json.error?.message ?? 'Failed to load folder');
      setContents(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load folder');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) { setCurrentPath(initialPath); void fetchContents(initialPath); }
  }, [isOpen, initialPath, fetchContents]);

  const navigateTo = (path: string) => { setCurrentPath(path); void fetchContents(path); };

  const handleImport = async (file: SpFile) => {
    setImportingUrl(file.serverRelativeUrl);
    try { await onImport(file.serverRelativeUrl, file.name); }
    finally { setImportingUrl(null); }
  };

  if (!isOpen) return null;
  const isNotConfigured = error?.toLowerCase().includes('not configured');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl shadow-2xl flex flex-col max-h-[80vh]" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--ff-border-light)] shrink-0">
          <div className="p-2 rounded-lg bg-blue-500/10"><Folder className="h-4 w-4 text-blue-400" /></div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Browse SharePoint</h2>
            <p className="text-xs text-[var(--ff-text-tertiary)] truncate">{currentPath}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Breadcrumbs */}
        <div className="flex items-center gap-1 px-5 py-2 border-b border-[var(--ff-border-light)] shrink-0 overflow-x-auto">
          {breadcrumbs.map((crumb, index) => (
            <div key={crumb.path} className="flex items-center gap-1 shrink-0">
              {index === 0 ? (
                <button onClick={() => navigateTo(crumb.path)} className="flex items-center gap-1 text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors">
                  <Home className="h-3 w-3" />
                </button>
              ) : (
                <button
                  onClick={() => navigateTo(crumb.path)}
                  className={`text-xs transition-colors ${index === breadcrumbs.length - 1 ? 'text-[var(--ff-text-primary)] font-medium cursor-default' : 'text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'}`}
                >
                  {crumb.name}
                </button>
              )}
              {index < breadcrumbs.length - 1 && <ChevronRight className="h-3 w-3 text-[var(--ff-text-tertiary)]" />}
            </div>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-[var(--ff-text-tertiary)]">
              <Loader2 className="h-5 w-5 animate-spin" /><span className="text-sm">Loading...</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center gap-3 py-12 px-6 text-center">
              <AlertCircle className="h-8 w-8 text-red-400" />
              {isNotConfigured ? (
                <>
                  <p className="text-sm font-medium text-[var(--ff-text-primary)]">SharePoint not configured</p>
                  <p className="text-xs text-[var(--ff-text-secondary)]">Contact your admin to set up the Azure integration. Requires AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID, and SHAREPOINT_SITE_URL.</p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-[var(--ff-text-primary)]">Failed to load folder</p>
                  <p className="text-xs text-[var(--ff-text-secondary)]">{error}</p>
                  <button onClick={() => void fetchContents(currentPath)} className="text-xs text-blue-400 hover:text-blue-300 transition-colors">Retry</button>
                </>
              )}
            </div>
          ) : !contents || (contents.folders.length === 0 && contents.files.length === 0) ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-[var(--ff-text-tertiary)]">
              <Folder className="h-8 w-8" /><span className="text-sm">This folder is empty</span>
            </div>
          ) : (
            <div className="divide-y divide-[var(--ff-border-light)]">
              {contents.folders.map((folder) => (
                <button key={folder.serverRelativeUrl} onClick={() => navigateTo(folder.serverRelativeUrl)} className="w-full flex items-center gap-3 px-5 py-3 hover:bg-[var(--ff-bg-tertiary)] transition-colors text-left">
                  <div className="p-1.5 rounded bg-amber-500/10 shrink-0"><Folder className="h-4 w-4 text-amber-400" /></div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--ff-text-primary)] truncate">{folder.name}</p>
                    <p className="text-xs text-[var(--ff-text-tertiary)]">{folder.itemCount} item{folder.itemCount !== 1 ? 's' : ''}</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-[var(--ff-text-tertiary)] shrink-0" />
                </button>
              ))}
              {contents.files.map((file) => {
                const Icon = getFileIcon(file.name);
                const isImporting = importingUrl === file.serverRelativeUrl;
                return (
                  <div key={file.serverRelativeUrl} className="flex items-center gap-3 px-5 py-3 hover:bg-[var(--ff-bg-tertiary)] transition-colors">
                    <div className="p-1.5 rounded bg-blue-500/10 shrink-0"><Icon className="h-4 w-4 text-blue-400" /></div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[var(--ff-text-primary)] truncate">{file.name}</p>
                      <p className="text-xs text-[var(--ff-text-tertiary)]">{formatBytes(file.size)}{file.modified ? ` · ${formatDate(file.modified)}` : ''}</p>
                    </div>
                    <button onClick={() => void handleImport(file)} disabled={isImporting || importingUrl !== null} className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                      {isImporting ? <><Loader2 className="h-3 w-3 animate-spin" /> Attaching...</> : 'Attach'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-[var(--ff-border-light)] px-5 py-3 flex items-center justify-end shrink-0">
          <button onClick={onClose} className="px-4 py-1.5 rounded text-xs border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
