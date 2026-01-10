/**
 * Jellyfin NFO Plugin
 * Parses Jellyfin/Kodi NFO files for movies and TV shows
 */

import { readFile, access } from 'fs/promises';
import { dirname, join } from 'path';
import { Parser } from 'xml2js';
import { franc } from 'franc-min';
import type { PluginManifest, ProcessRequest, CallbackPayload } from './types.js';
import { MetaCoreClient } from './meta-core-client.js';

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
    },
    config: {},
};

async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

async function parseNfoFile(nfoPath: string): Promise<any> {
    const content = await readFile(nfoPath, 'utf8');
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

        if (existingMeta?.fileType !== 'video') {
            await sendCallback({
                taskId: request.taskId,
                status: 'skipped',
                duration: Date.now() - startTime,
                reason: 'Not a video file',
            });
            return;
        }

        const metadata: Record<string, string> = {};
        const sets: Array<{ key: string; value: string }> = [];

        // Try file-specific NFO
        const nfoPath = filePath.replace(/\.[^.]+$/, '.nfo');
        if (await fileExists(nfoPath)) {
            try {
                const parsed = await parseNfoFile(nfoPath);
                const root = parsed.episodedetails || parsed.movie || parsed.tvshow;
                if (root) {
                    extractNfoData(root, metadata, sets, parsed.movie ? 'movie' : 'tvshow');
                }
            } catch (e) {
                console.log(`[jellyfin-nfo] Error parsing ${nfoPath}`);
            }
        }

        // Try tvshow.nfo in directory
        const tvshowNfo = join(dirname(filePath), 'tvshow.nfo');
        if (await fileExists(tvshowNfo)) {
            try {
                const parsed = await parseNfoFile(tvshowNfo);
                if (parsed.tvshow) {
                    extractNfoData(parsed.tvshow, metadata, sets, 'tvshow');
                }
            } catch (e) {
                console.log(`[jellyfin-nfo] Error parsing ${tvshowNfo}`);
            }
        }

        if (Object.keys(metadata).length > 0) {
            await metaCore.mergeMetadata(cid, metadata);
        }

        for (const { key, value } of sets) {
            await metaCore.addToSet(cid, key, value);
        }

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

function extractNfoData(
    root: any,
    metadata: Record<string, string>,
    sets: Array<{ key: string; value: string }>,
    videoType: string
): void {
    metadata.videoType = videoType;

    if (root.originaltitle) metadata.originalTitle = root.originaltitle;
    if (root.title && !metadata.originalTitle) metadata.originalTitle = root.title;
    if (root.episode) metadata.episode = String(root.episode);
    if (root.season) metadata.season = String(root.season);
    if (root.year) metadata.movieYear = String(root.year);
    if (root.rating) metadata.rating = String(root.rating);
    if (root.imdbid) metadata.imdbid = root.imdbid;
    if (root.tmdbid) metadata.tmdbid = String(root.tmdbid);
    if (root.anidbid) metadata.anidbid = String(root.anidbid);
    if (root.mpaa) metadata.mpaa = root.mpaa;
    if (root.releasedate) metadata.releasedate = root.releasedate;

    // Plot with language detection
    if (root.plot) {
        const lang = franc(root.plot);
        const langKey = lang && lang !== 'und' ? lang : 'eng';
        metadata[`plot/${langKey}`] = root.plot;
    }

    // Sets
    for (const genre of normalizeArray(root.genre)) {
        sets.push({ key: 'genres', value: genre });
    }
    for (const studio of normalizeArray(root.studio)) {
        sets.push({ key: 'studio', value: studio });
    }
    for (const tag of normalizeArray(root.tag || root.tags)) {
        sets.push({ key: 'tags', value: tag });
    }
}
