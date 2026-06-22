/**
 * index.js -- IINA plugin main entry.
 *
 * Registers a subtitle provider that:
 *   1. checks for an existing local SRT sidecar next to the video
 *      (or under ~/Library/Application Support/IINA-MultiASR/Subtitles/);
 *   2. if missing, extracts the audio track and runs the active ASR
 *      provider (MiMo or Doubao) to generate the English SRT;
 *   3. (optional) translates the SRT to the user's target language;
 *   4. writes both SRT files next to the source video (or fallback),
 *      and returns the absolute paths to IINA for immediate display.
 *
 * IINA loads the first returned file as the primary subtitle, and the
 * second (when present) as a secondary track for bilingual display.
 *
 * File naming: <basename>.<lang>.srt (e.g. "trailer.en.srt")
 */

import { Config } from "./config.js";
import { extractAudio } from "./audio/extractor.js";
import { parseSRT, cuesToSRT } from "./subtitle/srt.js";
import { createASRProvider } from "./providers/factory.js";
import { createTranslator } from "./translators/factory.js";
import { log } from "./utils/logger.js";
import { loadLocalSRT, saveSRT } from "./utils/local-store.js";

const { subtitle, core } = iina;

subtitle.registerProvider("multiasr", {
    search: async () => {
        // IINA hides providers that return 0 items. So we MUST return
        // at least one item even if the user hasn't configured an API
        // key yet -- otherwise the panel shows only "Open Subtitles"
        // and the user can't trigger download() to see the error.
        //
        // We do NOT call listModels() / network here. listModels() in
        // MiMo throws on missing API key, and the search() catch was
        // swallowing the error and returning []. Surface a static
        // placeholder instead; the real error (if any) fires in
        // download() and is shown via OSD.
        const asrConfig = Config.getASRConfig();
        const providerName = asrConfig.provider || "asr";
        const modelId = asrConfig.model || "default";
        return [subtitle.item({
            id: modelId,
            name: `${providerName.toUpperCase()} (${modelId})`,
            url: "https://example.invalid",
            format: "srt",
        })];
    },

    description: (item) => {
        return {
            name: item.data?.id || "Unknown",
            left: "",
            right: "Cloud ASR + Translate",
        };
    },

    download: async (item) => {
        try {
            return await runPipeline(item);
        } catch (e) {
            log.error(e.message);
            throw e;
        }
    },
});

async function runPipeline(item) {
    // 1. Validate configuration
    Config.validate();
    const videoUrl = core.status.url;
    if (!videoUrl) {
        throw new Error("No video is currently playing.");
    }
    log.info(`Pipeline start: ${videoUrl}`);

    // 2. Try local SRT cache for English transcript
    let englishSrt = null;
    let englishPath = null;
    const cachedEn = await loadLocalSRT(videoUrl, "en");
    if (cachedEn) {
        englishSrt = cachedEn.content;
        englishPath = cachedEn.path;
        core.osd(`MultiASR: loaded cached English SRT (${englishSrt.length} chars)`);
    } else {
        // 3. Extract audio
        core.osd("MultiASR: extracting audio...");
        const audioPath = await extractAudio(videoUrl);
        log.info(`Audio extracted to ${audioPath}`);

        // 4. ASR
        const asrConfig = Config.getASRConfig();
        const asrProvider = createASRProvider(asrConfig);
        const onASRProgress = (p, msg) =>
            core.osd(`MultiASR ASR: ${msg} (${p}%)`);

        englishSrt = await asrProvider.transcribe(audioPath, onASRProgress);
        log.info(`English SRT generated: ${englishSrt.length} chars`);

        // Persist next to video (with fallback to ~/Library/...)
        englishPath = await saveSRT(videoUrl, "en", englishSrt);
    }

    const out = [englishPath];

    // 5. Translation (optional)
    if (Config.getBool("enable_translation", true)) {
        const trConfig = Config.getTranslatorConfig();
        const translator = createTranslator(trConfig);
        const cues = parseSRT(englishSrt);
        const targetLang = Config.get("target_language", "zh-CN");
        const targetName = Config.getTargetLanguageName();
        const sourceLang = Config.get("source_language", "auto");
        const onTrProgress = (p, msg) =>
            core.osd(`MultiASR Translate: ${msg} (${p}%)`);

        // Try local cache for translation first
        const cachedTr = await loadLocalSRT(videoUrl, targetLang);
        let translatedPath;
        if (cachedTr) {
            translatedPath = cachedTr.path;
            core.osd(
                `MultiASR: loaded cached ${targetName} SRT (${cachedTr.content.length} chars)`,
            );
        } else {
            const translatedCues = await translator.translateCues(
                cues,
                sourceLang,
                targetName,
                onTrProgress,
            );
            const translatedSrt = cuesToSRT(translatedCues);
            translatedPath = await saveSRT(videoUrl, targetLang, translatedSrt);
        }

        out.push(translatedPath);
        if (Config.getBool("show_secondary_subtitle", true)) {
            core.osd(
                `MultiASR: done. Primary = English, Secondary = ${targetName}`,
            );
        } else {
            core.osd(`MultiASR: done. (Translated subtitle at ${translatedPath})`);
        }
    } else {
        core.osd("MultiASR: done. Primary subtitle loaded.");
    }

    return out;
}
