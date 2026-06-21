/**
 * providers/mimo.js ¡ª Xiaomi MiMo ASR provider.
 *
 * Uses the OpenAI-compatible /audio/transcriptions endpoint.
 * Reference: https://platform.xiaomimimo.com/docs
 *
 * Supports two response modes:
 *   - "verbose_json" (default): returns segments[] with start/end/text
 *     ¡ú we can convert to SRT directly without any LLM call
 *   - "json" / "text": returns just the text; we synthesize
 *     uniformly-spaced cues as a fallback
 */

import { BaseASRProvider, ASRError } from "./base.js";
import { postMultipart, withRetry } from "../utils/http.js";
import { cuesToSRT, formatTimestamp } from "../subtitle/srt.js";
import { log } from "../utils/logger.js";

const DEFAULT_TIMEOUT = 600_000; // 10 minutes for long videos

export class MiMoASRProvider extends BaseASRProvider {
    constructor(config) {
        super(config);
        this.providerName = "mimo";
    }

    validateCredentials() {
        if (!this.config.apiKey) {
            throw new ASRError("MiMo API key is required", { provider: "mimo", code: "AUTH_MISSING" });
        }
        if (!this.config.endpoint) {
            throw new ASRError("MiMo endpoint is required", { provider: "mimo", code: "ENDPOINT_MISSING" });
        }
    }

    async listModels() {
        this.validateCredentials();
        return [
            {
                id: this.config.model || "mimo-v2.5-asr",
                name: "MiMo ASR",
                description: "Xiaomi MiMo speech recognition (OpenAI-compatible)",
            },
        ];
    }

    /**
     * Transcribe `audioPath` via MiMo.
     * Returns SRT text. Calls onProgress(percent, message) periodically.
     */
    async transcribe(audioPath, onProgress = () => {}) {
        this.validateCredentials();
        onProgress(5, "Reading audio file...");

        const fileData = await readFileAsUint8(audioPath);
        onProgress(10, `Uploading ${(fileData.byteLength / 1024).toFixed(0)} KB to MiMo...`);

        const url = `${stripTrailingSlash(this.config.endpoint)}/audio/transcriptions`;
        const timeout = DEFAULT_TIMEOUT;

        const form = {
            file: {
                filename: "audio.wav",
                type: "audio/wav",
                data: fileData,
            },
            model: this.config.model || "mimo-v2.5-asr",
            response_format: "verbose_json",
        };

        const response = await withRetry(
            () => postMultipart(url, {
                headers: { "Authorization": `Bearer ${this.config.apiKey}` },
                form,
                timeoutMs: timeout,
            }),
            { attempts: 2 }
        );

        onProgress(85, "Parsing MiMo response...");

        if (typeof response === "string") {
            // text/plain fallback ¡ª synthesize evenly-spaced cues
            const text = response.trim();
            if (!text) throw new ASRError("MiMo returned empty text", { provider: "mimo" });
            return cuesToSRT([{ start: 0, end: 60, text }]);
        }

        if (response.segments && Array.isArray(response.segments) && response.segments.length) {
            return cuesToSRT(response.segments.map(s => ({
                start: s.start,
                end:   s.end,
                text:  s.text,
            })));
        }

        if (response.text) {
            return cuesToSRT([{ start: 0, end: 60, text: response.text.trim() }]);
        }

        throw new ASRError(`Unexpected MiMo response: ${JSON.stringify(response).slice(0, 200)}`, { provider: "mimo" });
    }
}

function stripTrailingSlash(s) { return s.replace(/\/+$/, ""); }

async function readFileAsUint8(path) {
    // IINA webview exposes a fetch() that can read file:// URLs
    const resp = await fetch(`file://${encodeURI(path)}`);
    if (!resp.ok) throw new Error(`Failed to read ${path}: ${resp.status}`);
    const buf = await resp.arrayBuffer();
    return new Uint8Array(buf);
}
