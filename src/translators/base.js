/**
 * translators/base.js ¡ª Abstract translation provider interface.
 *
 * All translators must implement:
 *   - validateCredentials()
 *   - async translate(text, sourceLang, targetLang): Promise<string>
 *
 * The default translateBatch() implementation chunks the SRT cues
 * and calls translate() per chunk. Subclasses may override to send
 * multi-line payloads for better context.
 */

export class TranslationError extends Error {
    constructor(message, { provider, code, cause } = {}) {
        super(message);
        this.name = "TranslationError";
        this.provider = provider;
        this.code = code;
        if (cause) this.cause = cause;
    }
}

export class BaseTranslator {
    constructor(config) {
        this.config = config;
        this.providerName = "base";
    }

    validateCredentials() {
        throw new Error("not implemented");
    }

    /**
     * Translate a single chunk of text. Implementations should be
     * reasonably idempotent (the chunk boundaries are arbitrary).
     */
    async translate(_text, _sourceLang, _targetLang) {
        throw new Error("not implemented");
    }

    /**
     * Translate an array of SRT cues, preserving timestamps. Each
     * cue is translated individually to avoid losing alignment.
     */
    async translateCues(cues, sourceLang, targetLang, onProgress = () => {}) {
        this.validateCredentials();
        const out = [];
        for (let i = 0; i < cues.length; i++) {
            const cue = cues[i];
            const translatedText = await this.translate(cue.text, sourceLang, targetLang);
            out.push({ start: cue.start, end: cue.end, text: translatedText });
            onProgress(Math.floor(((i + 1) / cues.length) * 100), `Translating cue ${i + 1}/${cues.length}`);
        }
        return out;
    }
}
