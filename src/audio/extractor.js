/**
 * audio/extractor.js ?? Extract an audio track from a video file via ffmpeg.
 *
 * The output is a 16kHz mono 16-bit PCM WAV ?? the format required by
 * both Doubao and MiMo ASR APIs. We pipe ffmpeg's stdout directly into
 * a temp file under @tmp.
 */

import { Config } from "../config.js";
import { log } from "../utils/logger.js";

function resolveFFmpegPath() {
    const configured = Config.get("ffmpeg_path");
    if (configured && iina.utils.fileInPath(configured)) {
        return configured;
    }
    // Try a few well-known locations
    const candidates = [
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ];
    for (const c of candidates) {
        if (iina.utils.fileInPath(c)) return c;
    }
    throw new Error("ffmpeg not found. Please install ffmpeg or set the path in preferences.");
}

/**
 * Extract audio from a video file (or pass-through an existing audio file).
 * Returns the absolute path of the produced WAV file.
 *
 * @param {string} sourcePath - path to the source media file
 * @returns {Promise<string>}
 */
export async function extractAudio(sourcePath) {
    const ffmpeg = resolveFFmpegPath();
    const tmpDir = iina.utils.resolvePath("@tmp");
    const outPath = `${tmpDir}/multiasr_${Date.now()}.wav`;

    const args = [
        "-y",
        "-i", sourcePath,
        "-ac", "1",            // mono
        "-ar", "16000",        // 16 kHz
        "-c:a", "pcm_s16le",   // 16-bit PCM (avoids -sample_fmt compatibility issues)
        "-f", "wav",
        outPath,
    ];

    log.info(`Extracting audio via ffmpeg ?? ${outPath}`);
    await iina.utils.exec(ffmpeg, ...args);
    return outPath;
}
