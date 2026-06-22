/**
 * translators/deepseek.js -- DeepSeek LLM translation provider.
 *
 * Same OpenAI-compatible protocol as MiMo. DeepSeek's deepseek-chat
 * model is excellent for translation tasks. (DeepSeek is text-only --
 * it does not offer an ASR API, hence we only use it here.)
 */

import { BaseTranslator, TranslationError } from "./base.js";
import { postJSON, withRetry } from "../utils/http.js";

export class DeepSeekTranslator extends BaseTranslator {
    constructor(config) {
        super(config);
        this.providerName = "deepseek";
    }

    validateCredentials() {
        if (!this.config.apiKey) {
            throw new TranslationError("DeepSeek API key is required", { provider: "deepseek", code: "AUTH_MISSING" });
        }
    }

    async translate(text, sourceLang, targetLang) {
        this.validateCredentials();
        const url = `${stripTrailingSlash(this.config.endpoint)}/chat/completions`;
        const systemPrompt = buildSystemPrompt(sourceLang, targetLang);
        const body = {
            model: this.config.model || "deepseek-chat",
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
            throw new TranslationError(`Empty DeepSeek translation: ${JSON.stringify(resp).slice(0, 200)}`, { provider: "deepseek" });
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
