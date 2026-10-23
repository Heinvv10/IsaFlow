// An in-memory stand-in for Supabase Storage, for the capture read suites. Only the two network calls are replaced:
// documentStorage (storeCapturedBytes / fetchRawBytes) stays REAL, so the pointer columns are written and read through
// the disposable database exactly as in production. A path the map does not hold is a missing object, with the same
// typed error the real download throws.
import type * as SupabaseStorage from '@/lib/supabaseStorage';

/** `${bucket}/${path}` -> bytes. Tests put objects here and delete them to simulate a missing object. */
export const objects = new Map<string, Buffer>();

export function fakeSupabaseStorage(real: typeof SupabaseStorage): typeof SupabaseStorage {
  return {
    ...real,
    uploadCapturedDocument: async (companyId, documentId, buffer) => {
      const path = `${companyId}/${documentId}`;
      objects.set(`${real.CAPTURED_DOCS_BUCKET}/${path}`, buffer);
      return { bucket: real.CAPTURED_DOCS_BUCKET, path };
    },
    downloadCapturedDocument: async (bucket, path) => {
      const found = objects.get(`${bucket}/${path}`);
      if (!found) throw new real.CapturedDocumentMissingError(path, 'Object not found');
      return found;
    },
  };
}
