/**
 * translators/mimo.js ?? MiMo LLM translation provider.
 *
 * Uses the OpenAI-compatible /chat/completions endpoint and sends
 * each cue as a separate user message, with a system prompt that
 * enforces "output only the translation" so we can preserve timing.
 *
 * Auth: `api-key: <tp-key>` header for Token Plan keys.
 */

import { BaseTranslator, TranslationError } from "./base.js";
import { postJSON, withRetry } from "../utils/http.js";
import { log } from "../utils/logger.js";

export class MiMoTranslator extends BaseTranslator {
    constructor(config) {
        super(config);
        this.providerName = "mimo";
    }

    validateCredentials() {
        if (!this.config.apiKey) {
            throw new TranslationError("MiMo API key is required", { provider: "mimo", code: "AUTH_MISSING" });
        }
        if (!this.config.endpoint) {
            throw new TranslationError("MiMo endpoint is required", { provider: "mimo", code: "ENDPOINT_MISSING" });
        }
    }

    async translate(text, sourceLang, targetLang) {
        this.validateCredentials();
        const url = `${stripTrailingSlash(this.config.endpoint)}/chat/completions`;
        const systemPrompt = buildSystemPrompt(sourceLang, targetLang);
        const body = {
            model: this.config.model || "mimo-v2.5",
            temperature: 0.2,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: text },
            ],
            max_completion_tokens: 4096,
        };

        const resp = await withRetry(
            () => postJSON(url, {
                headers: { "api-key": this.config.apiKey },
                body,
                timeoutMs: 60000,
            }),
            { attempts: 3, onRetry: (err) => log("warn", `MiMo translate retry: ${err.message}`) }
        );

        const message = resp?.choices?.[0]?.message || {};
        // mimo-v2.5 may emit the final answer in `content` or in
        // `reasoning_content` (reasoning model behavior). Prefer
        // `content`; fall back to `reasoning_content` if empty.
        let translated = (message.content || "").trim();
        if (!translated && typeof message.reasoning_content === "string") {
            // reasoning_content often contains a "Final translation:" prefix
            // or the answer wrapped in markdown code fences. Try to extract
            // the cleanest version.
            translated = extractAnswer(message.reasoning_content);
        }
        if (!translated) {
            throw new TranslationError(
                `Empty MiMo translation: ${JSON.stringify(resp).slice(0, 200)}`,
                { provider: "mimo", code: "EMPTY_RESPONSE" }
            );
        }
        return translated;
    }
}

function buildSystemPrompt(sourceLang, targetLang) {
    return `You are a subtitle translator. Translate the user's text from ${sourceLang === "auto" ? "the source language (auto-detect)" : sourceLang} into ${targetLang}.
Rules:
- Output ONLY the translated text, with no extra commentary, quotes, or labels.
- Preserve line breaks within the input.
- Keep on-screen reading-friendly phrasing (concise, no parentheticals).`;
}

function extractAnswer(reasoning) {
    if (!reasoning) return "";
    // Strip markdown code fences if present
    let s = reasoning
        .replace(/^```[a-zA-Z]*\s*\n/, "")
        .replace(/\n```\s*$/, "")
        .trim();
    // If the reasoning ends with a "Final translation: ..." line, use that
    const m = s.match(/(?:final\s+(?:translation|answer)\s*[:?]\s*)([\s\S]+)$/i);
    if (m) return m[1].trim();
    return s;
}

function stripTrailingSlash(s) { return s.replace(/\/+$/, ""); }
