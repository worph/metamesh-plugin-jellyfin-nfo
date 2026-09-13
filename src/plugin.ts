/**
 * Jellyfin NFO Plugin
 *
 * Parses Jellyfin/Kodi NFO files for movies and TV shows.
 *
 * Matches old JellyFinNfoProcessor output:
 * - videoType, originalTitle, titles/<lang3>/<name> (key-set: title + originaltitle)
 * - episode, season, movieYear
 * - rating, anidbid, imdbid, tmdbid, mpaa, criticrating, releasedate
 * - art/fanart, art/poster
 * - languages (add), genres (add), studio (add), plot/{lang}, tags (add)
 */

import { readFile, access } from 'fs/promises';
import { dirname, join } from 'path';
import { Parser } from 'xml2js';
import { franc } from 'franc-min';
import { anyTo_iso_639_3 } from '@metazla/filename-tools';
import type { PluginManifest, ProcessRequest, CallbackPayload } from './types.js';
import { MetaCoreClient } from './meta-core-client.js';
import { createWebDAVClient, WebDAVClient } from './webdav-client.js';

// Initialize WebDAV client if WEBDAV_URL is set
const webdavClient = createWebDAVClient();
if (webdavClient) {
    console.log('[jellyfin-nfo] Using WebDAV for file access');
} else {
    console.log('[jellyfin-nfo] Using direct filesystem access');
}

const englishIsoCode = 'eng';

/**
 * `titles/<lang3>/<name>` key-set member key (METADATA_KEYS.md §3): trimmed,
 * whitespace collapsed, `/` (the key-set separator) written as U+2215 `∕`.
 * `undefined` when nothing is left to name.
 */
function titleMemberKey(lang3: string, name: unknown): string | undefined {
    const clean = (typeof name === 'string' ? name : '').trim().replace(/\s+/g, ' ').replace(/\//g, '\u2215');
    return clean ? `titles/${lang3}/${clean}` : undefined;
}

export const manifest: PluginManifest = {
    id: 'jellyfin-nfo',
    name: 'Jellyfin NFO Parser',
    version: '1.0.0',
    description: 'Parses Jellyfin/Kodi NFO files for movies and TV shows',
    author: 'MetaMesh',
    dependencies: ['file-info', 'filename-parser'],
    priority: 25,
    color: '#9C27B0',
    defaultQueue: 'fast',
    timeout: 30000,
    schema: {
        videoType: { label: 'Video Type', type: 'string' },
        originalTitle: { label: 'Original Title', type: 'string' },
        season: { label: 'Season Number', type: 'string' },
        episode: { label: 'Episode Number', type: 'string' },
        movieYear: { label: 'Release Year', type: 'number' },
        rating: { label: 'Rating', type: 'string' },
        imdbid: { label: 'IMDB ID', type: 'string' },
        tmdbid: { label: 'TMDB ID', type: 'string' },
        anidbid: { label: 'AniDB ID', type: 'string' },
        'art/poster': { label: 'Poster CID', type: 'cid' },
        'art/fanart': { label: 'Fanart CID', type: 'cid' },
    },
    config: {},
};

async function fileExists(path: string): Promise<boolean> {
    if (webdavClient) {
        return webdavClient.exists(path);
    }
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

async function readNfoContent(nfoPath: string): Promise<string> {
    if (webdavClient) {
        return webdavClient.readText(nfoPath, 'utf8');
    }
    return readFile(nfoPath, 'utf8');
}

async function parseNfoFile(nfoPath: string): Promise<any> {
    const content = await readNfoContent(nfoPath);
    const parser = new Parser({ explicitArray: false, mergeAttrs: true });
    return parser.parseStringPromise(content);
}

function normalizeArray(value: any): string[] {
    if (!value) return [];
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value;
    return [];
}

export async function process(
    request: ProcessRequest,
    sendCallback: (payload: CallbackPayload) => Promise<void>
): Promise<void> {
    const startTime = Date.now();
    const metaCore = new MetaCoreClient(request.metaCoreUrl);

    try {
        const { cid, filePath, existingMeta } = request;

        // Only process video files
        if (existingMeta?.fileType !== 'video') {
            await sendCallback({
                taskId: request.taskId,
                status: 'skipped',
                duration: Date.now() - startTime,
                reason: 'Not a video file',
            });
            return;
        }

        // Try file-specific NFO first
        const nfoPath = filePath.replace(/\.[^.]+$/, '.nfo');
        if (await fileExists(nfoPath)) {
            try {
                const nfoContent = await readNfoContent(nfoPath);
                const parser = new Parser({ explicitArray: false, mergeAttrs: true });
                const parsed = await parser.parseStringPromise(nfoContent);
                await extractNfoData(metaCore, cid, parsed, filePath);
            } catch (error) {
                console.debug(`[jellyfin-nfo] Error parsing file NFO ${nfoPath}: ${error}`);
            }
        }

        // Then try folder-level NFO (tvshow.nfo)
        const dirPath = dirname(filePath);
        const tvShowNfoPath = join(dirPath, 'tvshow.nfo');
        if (await fileExists(tvShowNfoPath)) {
            try {
                const nfoContent = await readNfoContent(tvShowNfoPath);
                const parser = new Parser({ explicitArray: false, mergeAttrs: true });
                const parsed = await parser.parseStringPromise(nfoContent);
                await extractNfoData(metaCore, cid, parsed, filePath);
            } catch (error) {
                console.debug(`[jellyfin-nfo] Error parsing folder NFO ${tvShowNfoPath}: ${error}`);
            }
        }

        const mode = webdavClient ? 'WebDAV' : 'filesystem';
        console.log(`[jellyfin-nfo] Processed NFO for ${filePath} (${mode})`);

        await sendCallback({
            taskId: request.taskId,
            status: 'completed',
            duration: Date.now() - startTime,
        });
    } catch (error) {
        await sendCallback({
            taskId: request.taskId,
            status: 'failed',
            duration: Date.now() - startTime,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

/**
 * Extract data from parsed NFO
 */
async function extractNfoData(
    metaCore: MetaCoreClient,
    cid: string,
    parsed: any,
    filePath: string
): Promise<void> {
    // Find the root element (episodedetails, movie, or tvshow)
    const root = parsed.episodedetails || parsed.movie || parsed.tvshow;
    if (!root) {
        return;
    }

    // Determine video type
    const videoType = parsed.movie ? 'movie' : 'tvshow';
    await metaCore.setProperty(cid, 'videoType', videoType);

    // Basic metadata
    if (root.originaltitle) {
        await metaCore.setProperty(cid, 'originalTitle', root.originaltitle);
    }

    // Both names are `titles/<lang3>/<name>` key-set members (METADATA_KEYS.md
    // §3). An NFO without a <language> files them under `und` — the language of
    // a name is not guessed — and adds nothing to `languages`.
    const nfoLang = anyTo_iso_639_3(root.language);
    const nameMembers: Record<string, string> = {};
    for (const name of [root.originaltitle, root.title]) {
        const key = titleMemberKey(nfoLang || 'und', name);
        if (key) nameMembers[key] = 'true';
    }
    if (Object.keys(nameMembers).length > 0) {
        await metaCore.mergeMetadata(cid, nameMembers);
        if (nfoLang) {
            await metaCore.addToSet(cid, 'languages', nfoLang);
        }
    }

    // Episode/Season info
    try {
        if (root.episode && parseInt(root.episode) > 0) {
            await metaCore.setProperty(cid, 'episode', String(root.episode));
        }
    } catch (e) {
        console.debug(`[jellyfin-nfo] Error parsing episode: ${e}`);
    }

    try {
        if (root.season && parseInt(root.season) > 0) {
            await metaCore.setProperty(cid, 'season', String(root.season));
        }
    } catch (e) {
        console.debug(`[jellyfin-nfo] Error parsing season: ${e}`);
    }

    // Year (movieYear)
    if (root.year) await metaCore.setProperty(cid, 'movieYear', String(root.year));
    if (root.rating) await metaCore.setProperty(cid, 'rating', String(root.rating));
    if (root.anidbid) await metaCore.setProperty(cid, 'anidbid', String(root.anidbid));
    if (root.imdbid) await metaCore.setProperty(cid, 'imdbid', String(root.imdbid));
    if (root.tmdbid) await metaCore.setProperty(cid, 'tmdbid', String(root.tmdbid));
    if (root.mpaa) await metaCore.setProperty(cid, 'mpaa', String(root.mpaa));
    if (root.criticrating) await metaCore.setProperty(cid, 'criticrating', String(root.criticrating));
    if (root.releasedate) await metaCore.setProperty(cid, 'releasedate', String(root.releasedate));

    // Art (poster and fanart) - compute CIDs using meta-core API
    if (root.art?.poster) {
        try {
            const posterCid = await metaCore.computeFileCID(root.art.poster);
            if (posterCid) await metaCore.setProperty(cid, 'art/poster', posterCid);
        } catch (e) {
            console.debug(`[jellyfin-nfo] Error getting poster CID: ${e}`);
        }
    }
    if (root.art?.fanart) {
        try {
            const fanartCid = await metaCore.computeFileCID(root.art.fanart);
            if (fanartCid) await metaCore.setProperty(cid, 'art/fanart', fanartCid);
        } catch (e) {
            console.debug(`[jellyfin-nfo] Error getting fanart CID: ${e}`);
        }
    }

    // Languages (add from root.language)
    if (root.language) {
        await metaCore.addToSet(cid, 'languages', String(root.language));
    }

    // Genres (add)
    try {
        const genres = normalizeArray(root.genre);
        for (const genre of genres) {
            await metaCore.addToSet(cid, 'genres', String(genre));
        }
    } catch (e) {
        console.debug(`[jellyfin-nfo] Error parsing genres: ${e}`);
    }

    // Studios (add)
    try {
        const studios = normalizeArray(root.studio);
        for (const studio of studios) {
            await metaCore.addToSet(cid, 'studio', String(studio));
        }
    } catch (e) {
        console.debug(`[jellyfin-nfo] Error parsing studios: ${e}`);
    }

    // Tags (add)
    try {
        const tags = normalizeArray(root.tag || root.tags);
        for (const tag of tags) {
            await metaCore.addToSet(cid, 'tags', String(tag));
        }
    } catch (e) {
        console.debug(`[jellyfin-nfo] Error parsing tags: ${e}`);
    }

    // Plot
    if (root.plot) {
        try {
            const plotLang = franc(root.plot);
            if (plotLang && plotLang !== 'und') {
                await metaCore.setProperty(cid, `plot/${plotLang}`, root.plot);
            } else {
                await metaCore.setProperty(cid, `plot/${englishIsoCode}`, root.plot);
            }
        } catch (e) {
            await metaCore.setProperty(cid, `plot/${englishIsoCode}`, root.plot);
        }
    }

    console.debug(`[jellyfin-nfo] Extracted NFO data for ${filePath}`);
}
