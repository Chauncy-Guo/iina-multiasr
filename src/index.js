/**
 * index.js -- IINA plugin main entry.
 *
 * Two-stage pipeline, each triggered independently from the sidebar:
 *
 *   Stage 1 "generate-original":
 *     extractAudio -> ASR -> saveSRT(en) -> loadTrack(primary)
 *     Reports progress via "original-progress" messages (0-100%).
 *
 *   Stage 2 "translate-subtitle":
 *     parseSRT(originalSrt) -> translator.translateCues -> saveSRT(lang)
 *     -> loadTrack(secondary)
 *     Reports progress via "translate-progress" messages (0-100%).
 *
 * Stage 2 requires Stage 1 to have completed (the sidebar locks the
 * translate button until then). Both stages honor a local SRT cache
 * so re-running is fast.
 */

import { Config } from "./config.js";
import { extractAudio } from "./audio/extractor.js";
import { parseSRT, cuesToASS } from "./subtitle/srt.js";
import { createASRProvider } from "./providers/factory.js";
import { createTranslator } from "./translators/factory.js";
import { log } from "./utils/logger.js";
import { loadLocalSRT, saveSRT } from "./utils/local-store.js";

const { subtitle, sidebar, menu, event, core, mpv, console } = iina;

console.log("MultiASR: main entry loaded");

// Force mpv to interpret subtitle files as UTF-8. Without this,
// SRT files with CJK characters may display as white squares.
function forceUtf8SubCodepage() {
    try { mpv.set("sub-codepage", "utf-8"); } catch (_) {}
}

// In-memory cache of the most recent original SRT for the current
// video, so the translate stage doesn't need to re-read from disk.
let currentOriginalSrt = null;
let currentOriginalPath = null;
let currentVideoUrl = null;

// --- Menu: add "Show Sidebar" so users can open the panel manually ---
event.on("iina.menu-update", () => {
    menu.removeAllItems();
    menu.addItem(
        menu.item("Show MultiASR Sidebar", () => {
            sidebar.show();
        }, { keyBinding: "Meta+p", enabled: core.window.visible }),
    );
});

// --- Sidebar: load HTML and wire up message handlers ---
event.on("iina.window-loaded", () => {
    sidebar.loadFile("dist/ui/sidebar/index.html");

    // Stage 1: generate original-language subtitle via ASR
    sidebar.onMessage("generate-original", async () => {
        try {
            const path = await generateOriginalSubtitle();
            sidebar.postMessage("original-progress", {
                percent: 100,
                message: `Done. Saved: ${path}`,
                state: "done",
                path,
            });
        } catch (e) {
            log.error(`Stage 1 failed: ${e.message}`);
            sidebar.postMessage("original-progress", {
                percent: 0,
                message: `Error: ${e.message}`,
                state: "error",
            });
        }
    });

    // Stage 2: translate the original subtitle into target language
    sidebar.onMessage("translate-subtitle", async (data) => {
        try {
            const targetLang = (data && data.targetLang) || Config.get("target_language", "zh-CN");
            const path = await translateSubtitle(targetLang);
            sidebar.postMessage("translate-progress", {
                percent: 100,
                message: `Done. Saved: ${path}`,
                state: "done",
                path,
            });
        } catch (e) {
            log.error(`Stage 2 failed: ${e.message}`);
            sidebar.postMessage("translate-progress", {
                percent: 0,
                message: `Error: ${e.message}`,
                state: "error",
            });
        }
    });

    // Sidebar asks for current video info to display
    sidebar.onMessage("get-video-info", () => {
        sendVideoInfo();
    });
});

function sendVideoInfo() {
    sidebar.postMessage("video-info", {
        title: core.status.title || "(no video)",
        url: core.status.url || "",
    });
}

// --- Subtitle provider: use CUSTOM_IMPLEMENTATION so IINA defers to
//     our sidebar UI instead of showing a search-result list. ---
subtitle.registerProvider("multiasr", {
    search: async () => {
        sidebar.show();
        return subtitle.CUSTOM_IMPLEMENTATION;
    },
    description: (item) => null,
    download: async (item) => null,
});

// =========================================================================
// Stage 1: Original subtitle generation (ASR)
// =========================================================================

async function generateOriginalSubtitle() {
    Config.validate();
    const videoUrl = core.status.url;
    if (!videoUrl) {
        throw new Error("No video is currently playing.");
    }
    currentVideoUrl = videoUrl;
    log.info(`Stage 1 start: ${videoUrl}`);

    // 1. Try local SRT cache first
    const cachedEn = await loadLocalSRT(videoUrl, "en");
    if (cachedEn) {
        currentOriginalSrt = cachedEn.content;
        currentOriginalPath = cachedEn.path;
        core.osd("MultiASR: loaded cached original SRT");
        sidebar.postMessage("original-progress", {
            percent: 100,
            message: `Loaded cached SRT: ${cachedEn.path}`,
            state: "running",
        });
        try {
            forceUtf8SubCodepage();
            core.subtitle.loadTrack(currentOriginalPath);
        } catch (e) {
            log.warn(`Failed to load subtitle track: ${e.message}`);
        }
        return currentOriginalPath;
    }

    // 2. Extract audio
    sidebar.postMessage("original-progress", {
        percent: 5,
        message: "Extracting audio...",
        state: "running",
    });
    core.osd("MultiASR: extracting audio...");
    const audioPath = await extractAudio(videoUrl);
    log.info(`Audio extracted to ${audioPath}`);

    // 3. ASR transcription
    const asrConfig = Config.getASRConfig();
    const asrProvider = createASRProvider(asrConfig);
    const onASRProgress = (p, msg) => {
        core.osd(`MultiASR ASR: ${msg} (${p}%)`);
        sidebar.postMessage("original-progress", {
            percent: p,
            message: `ASR: ${msg}`,
            state: "running",
        });
    };

    const englishSrt = await asrProvider.transcribe(audioPath, onASRProgress);
    log.info(`Original SRT generated: ${englishSrt.length} chars`);

    // 4. Save SRT
    sidebar.postMessage("original-progress", {
        percent: 95,
        message: "Saving subtitle file...",
        state: "running",
    });
    const englishPath = await saveSRT(videoUrl, "en", englishSrt);
    currentOriginalSrt = englishSrt;
    currentOriginalPath = englishPath;

    // 5. Load into IINA as primary track
    try {
        forceUtf8SubCodepage();
        core.subtitle.loadTrack(englishPath);
    } catch (e) {
        log.warn(`Failed to load subtitle track: ${e.message}`);
    }
    core.osd("MultiASR: original subtitle loaded.");
    return englishPath;
}

// =========================================================================
// Stage 2: Translation
// =========================================================================

async function translateSubtitle(targetLang) {
    if (!currentOriginalSrt || !currentOriginalPath) {
        throw new Error("Please generate the original subtitle first (step 1).");
    }
    const videoUrl = currentVideoUrl || core.status.url;
    if (!videoUrl) {
        throw new Error("No video is currently playing.");
    }

    log.info(`Stage 2 start: target=${targetLang}`);

    // 1. Try local cache for this target language
    const cachedTr = await loadLocalSRT(videoUrl, targetLang);
    if (cachedTr) {
        core.osd(`MultiASR: loaded cached ${targetLang} SRT`);
        sidebar.postMessage("translate-progress", {
            percent: 100,
            message: `Loaded cached SRT: ${cachedTr.path}`,
            state: "running",
        });
        try {
            forceUtf8SubCodepage();
            core.subtitle.loadTrack(cachedTr.path, { secondary: true });
        } catch (e) {
            log.warn(`Failed to load secondary track: ${e.message}`);
        }
        return cachedTr.path;
    }

    // 2. Translate cues
    const trConfig = Config.getTranslatorConfig();
    const translator = createTranslator(trConfig);
    const cues = parseSRT(currentOriginalSrt);
    const targetName = langCodeToName(targetLang);
    const sourceLang = Config.get("source_language", "auto");

    sidebar.postMessage("translate-progress", {
        percent: 0,
        message: `Translating ${cues.length} cues to ${targetName}...`,
        state: "running",
    });

    const onTrProgress = (p, msg) => {
        core.osd(`MultiASR Translate: ${msg} (${p}%)`);
        sidebar.postMessage("translate-progress", {
            percent: p,
            message: msg,
            state: "running",
        });
    };

    const translatedCues = await translator.translateCues(
        cues,
        sourceLang,
        targetName,
        onTrProgress,
    );
    const translatedSrt = cuesToASS(translatedCues, `Translated (${targetLang})`);

    // 3. Save translated SRT
    sidebar.postMessage("translate-progress", {
        percent: 95,
        message: "Saving translated subtitle...",
        state: "running",
    });
    const translatedPath = await saveSRT(videoUrl, targetLang, translatedSrt);

    // 4. Load as secondary track
    try {
        forceUtf8SubCodepage();
        core.subtitle.loadTrack(translatedPath, { secondary: true });
    } catch (e) {
        log.warn(`Failed to load secondary track: ${e.message}`);
    }
    core.osd(`MultiASR: ${targetName} subtitle loaded as secondary.`);
    return translatedPath;
}

// =========================================================================
// Helpers
// =========================================================================

function langCodeToName(code) {
    const map = {
        "zh-CN": "Simplified Chinese",
        "zh-TW": "Traditional Chinese",
        "ja": "Japanese",
        "ko": "Korean",
        "fr": "French",
        "de": "German",
        "es": "Spanish",
        "ru": "Russian",
        "pt": "Portuguese",
        "it": "Italian",
        "ar": "Arabic",
        "th": "Thai",
        "vi": "Vietnamese",
    };
    return map[code] || code;
}
