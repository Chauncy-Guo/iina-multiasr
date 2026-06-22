/**
 * utils/local-store.js -- Persist and look up generated SRT files on disk.
 *
 * Naming convention (placed next to the source video):
 *   /path/to/Movie.mp4  ->  /path/to/Movie.<lang>.srt
 *
 *   <lang> is a short ISO tag: "en" (transcript), "zh-CN", "ja", etc.
 *
 * Two-tier storage strategy:
 *   1. Prefer the video's own directory (so the file travels with the
 *      video and IINA's auto sidecar detection finds it next time).
 *   2. If the video directory is read-only, fall back to
 *      ~/Library/Application Support/IINA-MultiASR/Subtitles/<basename>/
 *      keyed by a stable hash of the absolute video path, so the same
 *      video always maps to the same subtitle folder across sessions.
 *
 * All write paths go through atomic write (write to <path>.tmp then
 * rename) to avoid leaving half-written SRT files that IINA might
 * try to load mid-generation.
 */

import { log } from "./logger.js";
import { readFile, writeFile, rename, mkdir, stat, unlink, access, constants } from "./fs-shim.js";

// The fallback is intentionally inside the IINA-managed Application
// Support tree so macOS won't quarantine or prompt for permissions.
const FALLBACK_ROOT = "~/Library/Application Support/IINA-MultiASR/Subtitles";

/**
 * Compute the <basename> used for SRT sidecar naming.
 *   "Trailer.mp4" -> "Trailer"
 *   "trailer.MKV" -> "trailer"
 *   "/a/b/.hidden.mp4" -> ".hidden"
 */
function basenameNoExt(videoPath) {
    const base = videoPath.replace(/\/+$/, "").split("/").pop() || "video";
    return base.replace(/\.[^.]+$/, "");
}

function langTag(lang) {
    // Use a filename-safe form: zh-CN -> zh-CN, en -> en, fr -> fr
    return String(lang || "en").replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Compute a stable short hash of the absolute video path. Used to
 * bucket fallback files when the source directory is read-only.
 */
function pathHash(p) {
    // FNV-1a 32-bit, returned as 8-char hex
    let h = 0x811c9dc5;
    for (let i = 0; i < p.length; i++) {
        h ^= p.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
    }
    return ("00000000" + h.toString(16)).slice(-8);
}

function expandHome(p) {
    if (p.startsWith("~/")) {
        return (process.env.HOME || "") + p.slice(1);
    }
    return p;
}

async function dirWritable(dir) {
    if (!dir) return false;
    try {
        await access(dir, constants.W_OK);
        return true;
    } catch (_) {
        return false;
    }
}

async function dirExists(p) {
    try {
        const s = await stat(p);
        return s.isDirectory();
    } catch (_) {
        return false;
    }
}

async function fileExists(p) {
    try {
        const s = await stat(p);
        return s.isFile();
    } catch (_) {
        return false;
    }
}

/**
 * Resolve the writable save directory for a given video path.
 * Returns { dir, isFallback, fallbackBucket }.
 */
export async function resolveSaveDir(videoPath) {
    const parentDir = videoPath.replace(/\/[^/]+$/, "");

    // Tier 1: video directory
    if (await dirWritable(parentDir)) {
        return { dir: parentDir, isFallback: false };
    }

    // Tier 2: fallback under ~/Library/Application Support/...
    const bucket = basenameNoExt(videoPath) + "_" + pathHash(videoPath);
    const fallback = expandHome(FALLBACK_ROOT) + "/" + bucket;
    try {
        if (!(await dirExists(fallback))) {
            await mkdir(fallback, { recursive: true });
        }
    } catch (e) {
        log.warn(`Failed to create fallback subtitle dir: ${e.message}`);
        // Last resort: IINA @tmp
        const iinaRef = (typeof iina !== "undefined") ? iina : null;
        const tmp = (iinaRef?.utils?.resolvePath && iinaRef.utils.resolvePath("@tmp")) || "/tmp";
        return { dir: tmp, isFallback: true, fallbackBucket: "tmp" };
    }
    return { dir: fallback, isFallback: true, fallbackBucket: bucket };
}

/**
 * Compute the sidecar SRT path for a (video, lang) pair, given the
 * resolved save dir from resolveSaveDir().
 */
export function srtPath(saveDir, videoPath, lang) {
    return `${saveDir.dir}/${basenameNoExt(videoPath)}.${langTag(lang)}.srt`;
}

/**
 * Read an existing SRT sidecar if present.
 * Returns { path, content } or null.
 */
export async function loadLocalSRT(videoPath, lang) {
    const base = basenameNoExt(videoPath);
    const parentDir = videoPath.replace(/\/[^/]+$/, "");
    const candidates = [
        `${parentDir}/${base}.${langTag(lang)}.srt`,
    ];
    // Add fallback dir candidate
    try {
        const bucket = base + "_" + pathHash(videoPath);
        candidates.push(`${expandHome(FALLBACK_ROOT)}/${bucket}/${base}.${langTag(lang)}.srt`);
    } catch (_) {}

    for (const p of candidates) {
        if (await fileExists(p)) {
            try {
                const content = await readFile(p, "utf-8");
                if (content && content.trim().length) {
                    log.info(`Loaded cached SRT: ${p}`);
                    return { path: p, content };
                }
            } catch (e) {
                log.warn(`Failed to read ${p}: ${e.message}`);
            }
        }
    }
    return null;
}

/**
 * Save SRT content to disk next to the video, with fallback to the
 * Application Support tree. Returns the absolute path written.
 */
export async function saveSRT(videoPath, lang, content) {
    const saveDir = await resolveSaveDir(videoPath);
    const target = srtPath(saveDir, videoPath, lang);
    // Write atomically: write to <target>.tmp then rename
    const tmp = target + ".tmp";
    try {
        await writeFile(tmp, content, "utf-8");
        await rename(tmp, target);
    } catch (e) {
        log.error(`Failed to write SRT to ${target}: ${e.message}`);
        // Clean up tmp if rename failed
        try { await unlink(tmp); } catch (_) {}
        throw e;
    }
    const where = saveDir.isFallback
        ? `fallback (${saveDir.fallbackBucket})`
        : "video directory";
    log.info(`Saved SRT to ${where}: ${target}`);
    return target;
}
