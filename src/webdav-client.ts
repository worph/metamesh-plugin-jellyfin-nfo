/**
 * WebDAV Client for Plugin File Access
 *
 * Provides HTTP-based file access to meta-sort's WebDAV endpoint.
 * Replaces direct filesystem access for containerized plugins.
 */

export interface FileStats {
    size: number;
    mtime?: Date;
}

export class WebDAVClient {
    private baseUrl: string;

    constructor(baseUrl: string) {
        // Remove trailing slash if present
        this.baseUrl = baseUrl.replace(/\/$/, '');
    }

    /**
     * Convert absolute file path to WebDAV URL
     * Strips /files prefix and appends to base URL
     */
    toWebDAVUrl(filePath: string): string {
        // filePath is like "/files/watch/movie.mkv"
        // We need to convert to "http://meta-sort-dev/webdav/watch/movie.mkv"
        let relativePath = filePath;

        // Strip /files prefix if present
        if (relativePath.startsWith('/files/')) {
            relativePath = relativePath.substring(6); // Remove "/files"
        } else if (relativePath.startsWith('/files')) {
            relativePath = relativePath.substring(6);
        }

        // Ensure path starts with /
        if (!relativePath.startsWith('/')) {
            relativePath = '/' + relativePath;
        }

        return this.baseUrl + relativePath;
    }

    /**
     * Get file stats (size, mtime) via HTTP HEAD request
     */
    async stat(filePath: string): Promise<FileStats> {
        const url = this.toWebDAVUrl(filePath);

        const response = await fetch(url, { method: 'HEAD' });

        if (!response.ok) {
            throw new Error(`WebDAV HEAD failed for ${filePath}: ${response.status} ${response.statusText}`);
        }

        const contentLength = response.headers.get('content-length');
        const lastModified = response.headers.get('last-modified');

        return {
            size: contentLength ? parseInt(contentLength, 10) : 0,
            mtime: lastModified ? new Date(lastModified) : undefined,
        };
    }

    /**
     * Read entire file as buffer (for small files like NFO)
     */
    async readFile(filePath: string): Promise<Buffer> {
        const url = this.toWebDAVUrl(filePath);

        const response = await fetch(url, { method: 'GET' });

        if (!response.ok) {
            throw new Error(`WebDAV GET failed for ${filePath}: ${response.status} ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }

    /**
     * Read file as text (for NFO XML files)
     */
    async readText(filePath: string, encoding: BufferEncoding = 'utf8'): Promise<string> {
        const buffer = await this.readFile(filePath);
        return buffer.toString(encoding);
    }

    /**
     * Check if file exists via HTTP HEAD
     */
    async exists(filePath: string): Promise<boolean> {
        const url = this.toWebDAVUrl(filePath);

        try {
            const response = await fetch(url, { method: 'HEAD' });
            return response.ok;
        } catch {
            return false;
        }
    }
}

/**
 * Create a WebDAV client from environment variables
 */
export function createWebDAVClient(): WebDAVClient | null {
    const webdavUrl = process.env.WEBDAV_URL;

    if (!webdavUrl) {
        console.warn('[webdav-client] WEBDAV_URL not set, WebDAV client unavailable');
        return null;
    }

    return new WebDAVClient(webdavUrl);
}
