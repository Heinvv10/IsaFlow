/**
 * VF Storage Adapter
 * Connects to the VF Server storage service (100.96.203.105:8091)
 *
 * Environment Variables:
 * - VF_STORAGE_URL: Override the base URL (default: http://100.96.203.105:8091)
 */

import { log } from '@/lib/logger';
import {
  VF_STORAGE_CONFIG,
  VFStorageUploadResponse,
  VFStorageFile,
} from '@/types/storage.types';

const VF_STORAGE_BASE_URL = process.env.VF_STORAGE_URL || VF_STORAGE_CONFIG.baseUrl;

/** VF Storage Service for file operations */
export class VFStorageService {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || VF_STORAGE_BASE_URL;
  }

  /** Check if VF Storage server is healthy */
  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      return response.ok;
    } catch (error) {
      log.warn('VF Storage health check failed', { data: error }, 'vf-storage');
      return false;
    }
  }

  /**
   * Upload a file to VF Storage
   * @param file   - File or Buffer to upload
   * @param type   - Storage type (e.g., 'accounting')
   * @param category - Category within type (e.g., 'supplier_invoice')
   * @param fileName - Original filename
   */
  async uploadFile(
    file: Buffer | File | Blob,
    type: string,
    category: string,
    fileName: string
  ): Promise<VFStorageUploadResponse> {
    try {
      const formData = new FormData();

      if (file instanceof Buffer) {
        const blob = new Blob([file as unknown as BlobPart]);
        formData.append('file', blob, fileName);
      } else {
        formData.append('file', file as Blob, fileName);
      }

      const url = `${this.baseUrl}/upload/${type}/${encodeURIComponent(category)}`;
      log.info(`Uploading to VF Storage: ${url}`, undefined, 'vf-storage');

      const response = await fetch(url, { method: 'POST', body: formData });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Upload failed: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      const actualFilename = (result.filename as string) || fileName;
      const actualPath = (result.path as string) || `${type}/${category}/${actualFilename}`;
      const actualUrl = `/storage/${actualPath}`;

      return {
        success: true,
        filename: actualFilename,
        path: actualPath,
        url: actualUrl,
        size: (result.size as number) || (file instanceof Buffer ? file.length : 0),
      };
    } catch (error) {
      log.error('VF Storage upload error', { data: error }, 'vf-storage');
      throw error;
    }
  }

  /** List files in a directory */
  async listFiles(type: string, category: string): Promise<VFStorageFile[]> {
    try {
      const url = `${this.baseUrl}/list/${type}/${category}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`List failed: ${response.status}`);
      }

      const result = await response.json();
      return (result.files as VFStorageFile[]) || [];
    } catch (error) {
      log.error('VF Storage list error', { data: error }, 'vf-storage');
      return [];
    }
  }

  /** Delete a file from VF Storage */
  async deleteFile(type: string, category: string, filename: string): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/delete/${type}/${category}/${filename}`;
      const response = await fetch(url, { method: 'DELETE' });

      if (!response.ok) {
        throw new Error(`Delete failed: ${response.status}`);
      }

      return true;
    } catch (error) {
      log.error('VF Storage delete error', { data: error }, 'vf-storage');
      return false;
    }
  }

  /** Get the full URL for a stored file (public HTTPS URL via /storage/ proxy) */
  getFileUrl(type: string, category: string, filename: string): string {
    return `/storage/${type}/${category}/${filename}`;
  }
}

// Singleton instance
export const vfStorage = new VFStorageService();

/**
 * Normalize a storage URL to ensure it uses the /storage/ proxy path.
 * Handles legacy URLs that were stored without the /storage/ prefix.
 */
export function normalizeStorageUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined;

  const vfDomains = ['vf.fibreflow.app', 'dev.fibreflow.app', 'app.fibreflow.app'];
  const isVFUrl = vfDomains.some((domain) => url.includes(domain));
  if (!isVFUrl) return url;

  if (url.includes('/storage/')) return url;

  const storagePaths = ['/procurement/', '/accounting/', '/staff/', '/fleet/', '/contractors/', '/assets/'];
  const needsStorage = storagePaths.some((path) => url.includes(path));
  if (!needsStorage) return url;

  for (const path of storagePaths) {
    if (url.includes(path)) {
      return url.replace(path, `/storage${path}`);
    }
  }

  return url;
}

export default VFStorageService;
