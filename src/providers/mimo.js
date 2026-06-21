/**
 * providers/mimo.js ùù Xiaomi MiMo ASR provider.
 *
 * Xiaomi MiMo (token-plan) does not expose a dedicated ASR endpoint.
 * We use the OpenAI-compatible /chat/completions endpoint with the
 * multimodal `input_audio` content type and ask the model to emit
 * SRT directly. This keeps the rest of the pipeline unchanged.
 *
 * Auth: `api-key: <tp-key>` header (not Authorization: Bearer).
 *
 * Reference: https://platform.xiaomimimo.com/docs
 */

import { BaseASRProvider, ASRError } from "./base.js";
import { postJSON, withRetry } from "../utils/http.js";
import { parseSRT, cuesToSRT, formatTimestamp } from "../subtitle/srt.js";
import { encodeBase64 } from "../protocol/base64.js";
import { log } from "../utils/logger.js";

const DEFAULT_TIMEOUT = 600_000; // 10 minutes for long videos

const SYSTEM_PROMPT = [
    "You are a professional audio transcriber.",
    "You will receive an audio clip and must output a valid SRT subtitle block that captures the spoken language verbatim.",
    "Critical output rule: the SRT block must appear in your final assistant `content` field, not in any internal reasoning. Do not preface it with analysis or commentary. Begin your reply directly with the SRT content.",
    "Rules:",
    " 1. Output ONLY the SRT block. No prose, no markdown fences, no commentary before or after.",
    " 2. Each cue: a sequential index, a timestamp line in HH:MM:SS,mmm --> HH:MM:SS,mmm format, then the transcribed text. Separate cues with a single blank line.",
    " 3. Timestamps must be strictly monotonically increasing, in chronological order, and the end time of each cue must be greater than its start time.",
    " 4. Estimate cue boundaries at natural phrase/breath boundaries. Aim for cues of roughly 2-6 seconds; split long sentences if needed, and merge very short interjections with the surrounding sentence.",
    " 5. Keep cues inside the audio's actual duration. Do not extend beyond the clip length.",
    " 6. Transcribe exactly what is spoken, including filler words (\"um\", \"uh\"). Do not translate, paraphrase, or add speaker labels unless a speaker switch is obvious."
].join("\n");

const USER_INSTRUCTION =
    "Transcribe the audio into SRT format. Output only the SRT block.";

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
                id: this.config.model || "mimo-v2.5",
                name: "MiMo (multimodal)",
                description: "Xiaomi MiMo via input_audio (OpenAI-compatible chat)",
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
        const audioBase64 = encodeBase64(fileData);
        onProgress(15, `Uploading audio (${(audioBase64.length / 1024).toFixed(0)} KB)...`);

        const url = `${stripTrailingSlash(this.config.endpoint)}/chat/completions`;
        const timeout = DEFAULT_TIMEOUT;

        const body = {
            model: this.config.model || "mimo-v2.5",
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                {
                    role: "user",
                    content: [
                        { type: "input_audio", input_audio: { data: audioBase64, format: "wav" } },
                        { type: "text", text: USER_INSTRUCTION },
                    ],
                },
            ],
            max_completion_tokens: 8192,
            temperature: 0,
        };

        const response = await withRetry(
            () => postJSON(url, {
                headers: { "api-key": this.config.apiKey },
                body,
                timeoutMs: timeout,
            }),
            { attempts: 2, onRetry: (err) => log("warn", `MiMo retry: ${err.message}`) }
        );

        onProgress(85, "Parsing MiMo response...");

        // mimo-v2.5 is a reasoning model: the final answer lives in
        // `content`; if it is empty we may still get a usable SRT block
        // in `reasoning_content` (model didn't finalize).
        const message = response?.choices?.[0]?.message || {};
        let raw = (message.content || "").trim();
        if (!raw && typeof message.reasoning_content === "string") {
            raw = extractSrtBlock(message.reasoning_content);
        }

        if (!raw) {
            throw new ASRError(
                `MiMo returned empty content. usage=${JSON.stringify(response?.usage || {})}`,
                { provider: "mimo", code: "EMPTY_RESPONSE" }
            );
        }

        const srt = normalizeSrt(raw);
        if (!srt) {
            throw new ASRError(
                `MiMo response could not be parsed as SRT. First 300 chars: ${raw.slice(0, 300)}`,
                { provider: "mimo", code: "PARSE_ERROR" }
            );
        }

        onProgress(100, "Transcription complete");
        return srt;
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

/**
 * Pull the SRT block out of a longer string. Looks for the first
 * "1\n00:00:..." header pattern; falls back to the whole string.
 */
function extractSrtBlock(text) {
    if (!text) return "";
    const m = text.match(/(?:^|\n)1\s*\n\s*\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/);
    if (!m) return text.trim();
    // m.index points at the start of the "1" (or the preceding \n);
    // preserve the "1" index line by slicing from m.index (not +1)
    // when the match was anchored at the very beginning of the text.
    const start = m.index === 0 ? 0 : m.index + 1;
    return text.slice(start).trim();
}

/**
 * Take whatever the model returned and try to coerce it to a valid SRT
 * string. Returns the empty string if no cues could be parsed.
 */
function normalizeSrt(raw) {
    // Strip markdown code fences if the model wrapped the SRT.
    let s = raw
        .replace(/^```(?:srt|subtitles?)?\s*\n/i, "")
        .replace(/\n```\s*$/i, "")
        .trim();

    const cues = parseSRT(s);
    if (cues.length) {
        // Re-emit via cuesToSRT to ensure formatting consistency
        // and monotonic re-numbering.
        return cuesToSRT(cues);
    }
    return "";
}

// Suppress unused-import lint warning when consumers don't need formatTimestamp
void formatTimestamp;
