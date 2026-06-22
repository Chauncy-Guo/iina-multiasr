/**
 * index.js -- IINA plugin main entry.
 *
 * Registers a subtitle provider that:
 *   1. extracts the audio track from the current video,
 *   2. calls the selected cloud ASR provider (MiMo or Doubao),
 *   3. (optional) translates the result via MiMo or DeepSeek,
 *   4. writes SRT files to @tmp/ and returns their paths to IINA.
 *
 * IINA will load the FIRST returned file as the primary subtitle.
 * If the user has "show_secondary_subtitle" enabled, the second file
 * is loaded as a secondary track for bilingual display.
 */

import { Config } from "./config.js";
import { extractAudio } from "./audio/extractor.js";
import { parseSRT, cuesToSRT, formatTimestamp } from "./subtitle/srt.js";
import { createASRProvider } from "./providers/factory.js";
import { createTranslator } from "./translators/factory.js";
import { log } from "./utils/logger.js";

const { subtitle, core } = iina;

subtitle.registerProvider("multiasr", {
    search: async () => {
        try {
            const asrConfig = Config.getASRConfig();
            const provider = createASRProvider(asrConfig);
            const models = await provider.listModels();
            return models.map((m) => subtitle.item({
                id: m.id,
                name: m.name,
                url: "https://example.invalid", // no remote URL; we generate locally
                format: "srt",
            }));
        } catch (e) {
            log.error(`search() failed: ${e.message}`);
            return [];
        }
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
            // IINA will display the OSD message
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

    // 2. Extract audio
    core.osd("MultiASR: extracting audio...");
    const audioPath = await extractAudio(videoUrl);
    log.info(`Audio extracted to ${audioPath}`);

    // 3. ASR
    const asrConfig = Config.getASRConfig();
    const asrProvider = createASRProvider(asrConfig);
    const onASRProgress = (p, msg) => core.osd(`MultiASR ASR: ${msg} (${p}%)`);

    const englishSrt = await asrProvider.transcribe(audioPath, onASRProgress);
    const tmpDir = iina.utils.resolvePath("@tmp");
    const base = `multiasr_${Date.now()}`;
    const englishPath = `${tmpDir}/${base}.en.srt`;
    await writeFile(englishPath, englishSrt);
    log.info(`English SRT written to ${englishPath}`);

    const out = [englishPath];

    // 4. Translation (optional)
    if (Config.getBool("enable_translation", true)) {
        const trConfig = Config.getTranslatorConfig();
        const translator = createTranslator(trConfig);
        const cues = parseSRT(englishSrt);
        const targetLang = Config.get("target_language", "zh-CN");
        const targetName = Config.getTargetLanguageName();
        const sourceLang = Config.get("source_language", "auto");
        const onTrProgress = (p, msg) => core.osd(`MultiASR Translate: ${msg} (${p}%)`);

        const translatedCues = await translator.translateCues(cues, sourceLang, targetName, onTrProgress);
        const translatedSrt = cuesToSRT(translatedCues);
        const translatedPath = `${tmpDir}/${base}.${targetLang}.srt`;
        await writeFile(translatedPath, translatedSrt);
        log.info(`Translated SRT written to ${translatedPath}`);

        out.push(translatedPath);
        if (Config.getBool("show_secondary_subtitle", true)) {
            core.osd(`MultiASR: done. Primary = English, Secondary = ${targetName}`);
        } else {
            core.osd(`MultiASR: done. (Translated subtitle is at ${translatedPath})`);
        }
    } else {
        core.osd("MultiASR: done. Primary subtitle loaded.");
    }

    return out;
}

async function writeFile(path, content) {
    // WKWebView can write via fetch() to a file:// URL with PUT, but
    // that requires the right CSP. A simpler path is to ask IINA
    // to exec a small shell command. We use a Python-less one-liner
    // via /usr/bin/tee or a small Node one-liner.
    const cmd = "/bin/sh";
    const args = ["-c", `cat > ${shellEscape(path)} <<'__MULTIASR_EOF__'\n${content}\n__MULTIASR_EOF__`];
    await iina.utils.exec(cmd, ...args);
}

function shellEscape(s) {
    return `"${String(s).replace(/"/g, '\\"')}"`;
}
