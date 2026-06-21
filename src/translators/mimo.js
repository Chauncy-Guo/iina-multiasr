/**
 * translators/mimo.js ¡ª MiMo LLM translation provider.
 *
 * Uses the OpenAI-compatible /chat/completions endpoint and sends
 * each cue as a separate user message, with a system prompt that
 * enforces "output only the translation" so we can preserve timing.
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
        };

        const resp = await withRetry(
            () => postJSON(url, {
                headers: { "Authorization": `Bearer ${this.config.apiKey}` },
                body,
                timeoutMs: 60000,
            }),
            { attempts: 3 }
        );

        const translated = resp?.choices?.[0]?.message?.content?.trim();
        if (!translated) {
            throw new TranslationError(`Empty MiMo translation: ${JSON.stringify(resp).slice(0, 200)}`, { provider: "mimo" });
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

function stripTrailingSlash(s) { return s.replace(/\/+$/, ""); }
