/**
 * utils/local-store.js -- Persist and look up generated subtitle files on disk.
 *
 * Uses ASS (Advanced SubStation Alpha) as the primary format because mpv on
 * macOS incorrectly detects encoding for SRT files, causing CJK characters
 * to display as white squares. ASS declares encoding and font explicitly.
 *
 * Naming convention (placed next to the source video):
 *   /path/to/Movie.mp4  ->  /path/to/Movie.<lang>.ass
 *
 *   <lang> is a short ISO tag: "en" (transcript), "zh-CN", "ja", etc.
 *
 * Two-tier storage strategy:
 *   1. Prefer the video's own directory (so the file travels with the
 *      video and IINA's auto sidecar detection finds it next time).
 *   2. If the video directory is truly read-only, fall back to
 *      ~/Library/Application Support/IINA-MultiASR/Subtitles/<basename>/
 *
 * Legacy .srt files are also checked for backward compatibility.
 */

import { log } from "./logger.js";
import { readFile, writeFile, rename, mkdir, stat, unlink, access, constants, execCapture } from "./fs-shim.js";

const FALLBACK_ROOT = "~/Library/Application Support/IINA-MultiASR/Subtitles";

function basenameNoExt(videoPath) {
    const base = videoPath.replace(/\/+$/, "").split("/").pop() || "video";
    return base.replace(/\.[^.]+$/, "");
}

function langTag(lang) {
    return String(lang || "en").replace(/[^A-Za-z0-9_-]/g, "_");
}

function pathHash(p) {
    let h = 0x811c9dc5;
    for (let i = 0; i < p.length; i++) {
        h ^= p.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
    }
    return ("00000000" + h.toString(16)).slice(-8);
}

/**
 * Get HOME directory. In IINA webview process.env is unavailable,
 * so we shell out to echo ~.
 */
let _cachedHome = null;
async function getHome() {
    if (_cachedHome) return _cachedHome;
    try {
        const { stdout } = await execCapture("/bin/sh", "-c", "echo -n $HOME");
        _cachedHome = stdout || "/tmp";
    } catch (_) {
        _cachedHome = "/tmp";
    }
    return _cachedHome;
}

function expandHomeSync(p) {
    if (p.startsWith("~/")) {
        // In IINA we can't get HOME synchronously, so this is only
        // used as a last-resort fallback. We'll use /tmp instead.
        return "/tmp" + p.slice(1);
    }
    return p;
}

async function expandHome(p) {
    if (p.startsWith("~/")) {
        const home = await getHome();
        return home + p.slice(1);
    }
    return p;
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
 * Strategy: try to save next to the video first. If that fails
 * (actually writing a tiny test file), fall back to Application Support.
 */
export async function resolveSaveDir(videoPath) {
    const parentDir = videoPath.replace(/\/[^/]+$/, "");

    // Tier 1: try writing a tiny test file next to the video
    try {
        await writeFile(`${parentDir}/.multiasr_test`, "ok");
        try { await unlink(`${parentDir}/.multiasr_test`); } catch (_) {}
        return { dir: parentDir, isFallback: false };
    } catch (_) {
        log.info(`Video directory not writable: ${parentDir}, using fallback`);
    }

    // Tier 2: fallback under ~/Library/Application Support/...
    const bucket = basenameNoExt(videoPath) + "_" + pathHash(videoPath);
    const fallback = await expandHome(FALLBACK_ROOT) + "/" + bucket;
    try {
        if (!(await dirExists(fallback))) {
            await mkdir(fallback, { recursive: true });
        }
    } catch (e) {
        log.warn(`Failed to create fallback subtitle dir: ${e.message}`);
        const env = (typeof process !== "undefined" && process.env) || {};
        const tmp = (env.TMPDIR && env.TMPDIR.length) ? env.TMPDIR.replace(/\/+$/, "") : "/tmp";
        return { dir: tmp, isFallback: true, fallbackBucket: "tmp" };
    }
    return { dir: fallback, isFallback: true, fallbackBucket: bucket };
}

export function srtPath(saveDir, videoPath, lang) {
    return `${saveDir.dir}/${basenameNoExt(videoPath)}.${langTag(lang)}.ass`;
}

/**
 * Read an existing subtitle file if present.
 * Checks ASS format first, then falls back to legacy SRT.
 * Returns { path, content } or null.
 */
export async function loadLocalSRT(videoPath, lang) {
    const base = basenameNoExt(videoPath);
    const parentDir = videoPath.replace(/\/[^/]+$/, "");
    const tag = langTag(lang);
    // Check ASS first (new format), then SRT (legacy)
    const extensions = [".ass", ".srt"];
    const candidates = [];
    for (const ext of extensions) {
        candidates.push(`${parentDir}/${base}.${tag}${ext}`);
    }
    // Add fallback dir candidates
    try {
        const fallbackBase = await expandHome(FALLBACK_ROOT);
        const bucket = base + "_" + pathHash(videoPath);
        for (const ext of extensions) {
            candidates.push(`${fallbackBase}/${bucket}/${base}.${tag}${ext}`);
        }
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
        try { await unlink(tmp); } catch (_) {}
        throw e;
    }
    const where = saveDir.isFallback
        ? `fallback (${saveDir.fallbackBucket})`
        : "video directory";
    log.info(`Saved SRT to ${where}: ${target}`);
    return target;
}
