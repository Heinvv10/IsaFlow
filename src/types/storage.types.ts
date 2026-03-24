/**
 * VF Storage Types
 * Copied from FibreFlow staff-document.types — storage-relevant subset only.
 * Used by vfStorageAdapter.
 */

/** VF Storage server configuration */
export const VF_STORAGE_CONFIG = {
  baseUrl: 'http://100.96.203.105:8091', // Internal (server-to-server)
  publicUrl: 'https://vf.fibreflow.app',  // Public (browser-facing)
  endpoints: {
    upload: '/upload',
    list: '/list',
    delete: '/delete',
    health: '/health',
  },
};

/** VF Storage upload response */
export interface VFStorageUploadResponse {
  success: boolean;
  filename: string;
  path: string;
  url: string;
  size: number;
}

/** VF Storage file list entry */
export interface VFStorageFile {
  name: string;
  path: string;
  size: number;
  modified: string;
}
