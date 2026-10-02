import { useState, useEffect, useCallback } from 'react';
import type { LinkedDocument, AccountingDocumentType } from '@/types/procurement/document.types';
import { log } from '@/lib/logger';
import { ApiEnvelopeError, apiErrorMessage, assertOk } from '@/lib/apiFetch';

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
      await assertOk(res, 'Could not load the documents - try again');
      const data = await res.json();
      if (!data.success) throw new ApiEnvelopeError(data.error?.message || 'Could not load the documents - try again');
      setDocuments(data.data);
    } catch (err) {
      log.error('Failed to fetch accounting documents', { error: err });
      setDocuments([]);
      setError(apiErrorMessage(err, 'Could not load the documents - try again'));
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId]);

  useEffect(() => {
    void fetchDocuments();
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
        await assertOk(res, 'Could not upload the document - try again');
        const data = await res.json();
        if (!data.success) throw new ApiEnvelopeError(data.error?.message || 'Could not upload the document - try again');
        setDocuments((prev) => [data.data, ...prev]);
      } catch (err) {
        log.error('Failed to upload accounting document', { error: err });
        setError(apiErrorMessage(err, 'Could not upload the document - try again'));
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
      await assertOk(res, 'Could not delete the document - try again');
      const data = await res.json();
      if (!data.success) throw new ApiEnvelopeError(data.error?.message || 'Could not delete the document - try again');
      setDocuments((prev) => prev.filter((d) => d.id !== documentId));
    } catch (err) {
      log.error('Failed to delete accounting document', { error: err });
      setError(apiErrorMessage(err, 'Could not delete the document - try again'));
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
