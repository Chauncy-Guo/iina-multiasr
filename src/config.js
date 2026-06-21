/**
 * config.js ¡ª Centralized preference access.
 *
 * All IINA preference reads/writes go through this module so that the
 * rest of the codebase never has to know preference key strings or
 * default values.
 */

const DEFAULTS = {
    asr_provider: "mimo",
    enable_translation: true,
    target_language: "zh-CN",
    source_language: "auto",
    show_secondary_subtitle: true,

    // MiMo
    mimo_api_key: "",
    mimo_endpoint: "https://api.xiaomimimo.com/v1",
    mimo_asr_model: "mimo-v2.5-asr",
    mimo_translation_model: "mimo-v2.5",

    // Doubao
    doubao_app_id: "",
    doubao_access_token: "",
    doubao_endpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
    doubao_resource_id: "volc.seedasr.sauc.duration",
    doubao_language: "en",

    // DeepSeek
    translator_provider: "mimo",
    deepseek_api_key: "",
    deepseek_endpoint: "https://api.deepseek.com/v1",
    deepseek_model: "deepseek-chat",

    // System
    ffmpeg_path: "/opt/homebrew/bin/ffmpeg",
    request_timeout_sec: 900,
};

class ConfigManager {
    constructor() {
        this._cache = new Map();
    }

    /**
     * Read a preference. Returns the default if missing or empty string.
     */
    get(key, fallback) {
        if (this._cache.has(key)) return this._cache.get(key);
        const defaultValue = fallback !== undefined ? fallback : DEFAULTS[key];
        let value;
        try {
            value = iina.preferences.get(key);
        } catch (e) {
            value = undefined;
        }
        if (value === undefined || value === null || value === "") {
            value = defaultValue;
        }
        this._cache.set(key, value);
        return value;
    }

    getBool(key, fallback) {
        const v = this.get(key, fallback);
        return v === true || v === "true" || v === 1 || v === "1";
    }

    getInt(key, fallback) {
        const v = parseInt(this.get(key, fallback), 10);
        return Number.isFinite(v) ? v : (fallback || 0);
    }

    /**
     * Return the active ASR provider configuration object.
     */
    getASRConfig() {
        const provider = this.get("asr_provider", "mimo");
        if (provider === "doubao") {
            return {
                provider,
                appId: this.get("doubao_app_id"),
                accessToken: this.get("doubao_access_token"),
                endpoint: this.get("doubao_endpoint"),
                resourceId: this.get("doubao_resource_id"),
                language: this.get("doubao_language", "en"),
            };
        }
        // mimo (default)
        return {
            provider,
            apiKey: this.get("mimo_api_key"),
            endpoint: this.get("mimo_endpoint"),
            model: this.get("mimo_asr_model"),
        };
    }

    /**
     * Return the active translation provider configuration object.
     */
    getTranslatorConfig() {
        const provider = this.get("translator_provider", "mimo");
        if (provider === "deepseek") {
            return {
                provider,
                apiKey: this.get("deepseek_api_key"),
                endpoint: this.get("deepseek_endpoint"),
                model: this.get("deepseek_model"),
            };
        }
        // mimo (default)
        return {
            provider,
            apiKey: this.get("mimo_api_key"),
            endpoint: this.get("mimo_endpoint"),
            model: this.get("mimo_translation_model"),
        };
    }

    /**
     * Validate credentials for the active providers. Throws on missing fields.
     */
    validate() {
        const asr = this.getASRConfig();
        if (asr.provider === "doubao") {
            if (!asr.appId || !asr.accessToken) {
                throw new Error("Doubao credentials missing: set App ID and Access Token in preferences.");
            }
        } else {
            if (!asr.apiKey) {
                throw new Error("MiMo API key missing: set it in preferences to use MiMo ASR.");
            }
        }
        if (this.getBool("enable_translation", true)) {
            const tr = this.getTranslatorConfig();
            if (!tr.apiKey) {
                throw new Error("Translator API key missing: configure MiMo or DeepSeek in preferences.");
            }
        }
    }

    /**
     * Map IINA target language code to a human-friendly name for prompts.
     */
    getTargetLanguageName() {
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
        return map[this.get("target_language")] || this.get("target_language");
    }
}

export const Config = new ConfigManager();
export { DEFAULTS };
