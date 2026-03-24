import { useState, useEffect, useCallback } from 'react';
import type { LinkedDocument, AccountingDocumentType } from '@/types/procurement/document.types';
import { log } from '@/lib/logger';

interface UseAccountingDocumentsReturn {
  documents: LinkedDocument[];
  loading: boolean;
  error: string | null;
  uploadDocument: (file: File, documentType: AccountingDocumentType, notes?: string) => Promise<void>;
  deleteDocument: (documentId: string) => Promise<void>;
  refreshDocuments: () => Promise<void>;
  uploading: boolean;
}

export function useAccountingDocuments(
  entityType: string,
  entityId: string | undefined
): UseAccountingDocumentsReturn {
  const [documents, setDocuments] = useState<LinkedDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDocuments = useCallback(async () => {
    if (!entityId) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/accounting/documents?entity_type=${entityType}&entity_id=${entityId}`
      );
      const data = await res.json();
      if (data.success) {
        setDocuments(data.data);
      } else {
        setError(data.error?.message || 'Failed to fetch documents');
      }
    } catch (err) {
      log.error('Failed to fetch accounting documents', { error: err });
      setError('Failed to load documents');
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId]);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  const uploadDocument = useCallback(
    async (file: File, documentType: AccountingDocumentType, notes?: string) => {
      if (!entityId) return;

      setUploading(true);
      setError(null);
      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('entity_type', entityType);
        formData.append('entity_id', entityId);
        formData.append('document_type', documentType);
        if (notes) formData.append('notes', notes);

        const res = await fetch('/api/accounting/documents', {
          method: 'POST',
          body: formData,
        });
        const data = await res.json();

        if (data.success) {
          setDocuments((prev) => [data.data, ...prev]);
        } else {
          setError(data.error?.message || 'Failed to upload document');
          throw new Error(data.error?.message || 'Upload failed');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        log.error('Failed to upload accounting document', { error: err });
        setError(msg);
        throw err;
      } finally {
        setUploading(false);
      }
    },
    [entityType, entityId]
  );

  const deleteDocument = useCallback(async (documentId: string) => {
    setError(null);
    try {
      const res = await fetch(`/api/accounting/documents?id=${documentId}`, {
        method: 'DELETE',
      });
      const data = await res.json();

      if (data.success) {
        setDocuments((prev) => prev.filter((d) => d.id !== documentId));
      } else {
        setError(data.error?.message || 'Failed to delete document');
      }
    } catch (err) {
      log.error('Failed to delete accounting document', { error: err });
      setError('Failed to delete document');
    }
  }, []);

  return {
    documents,
    loading,
    error,
    uploadDocument,
    deleteDocument,
    refreshDocuments: fetchDocuments,
    uploading,
  };
}
