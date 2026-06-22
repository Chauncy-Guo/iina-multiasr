/**
 * providers/base.js ?? Abstract ASR provider interface.
 *
 * All ASR providers must implement:
 *   - listModels(): Promise<Array<{ id, name, description }>>
 *   - transcribe(audioPath, onProgress): Promise<string>  // returns SRT text
 *
 * onProgress(percent: number, message: string) is optional and may be
 * called repeatedly with values 0..100.
 */

export class ASRError extends Error {
    constructor(message, { provider, code, cause } = {}) {
        super(message);
        this.name = "ASRError";
        this.provider = provider;
        this.code = code;
        if (cause) this.cause = cause;
    }
}

export class BaseASRProvider {
    constructor(config) {
        this.config = config;
        this.providerName = "base";
    }

    /** Validate that required credentials are present. */
    validateCredentials() {
        throw new Error("validateCredentials() not implemented");
    }

    /** Return the list of model entries to show in the IINA OSD picker. */
    async listModels() {
        throw new Error("listModels() not implemented");
    }

    /**
     * Transcribe the given audio file and return the result as an SRT
     * formatted string. Implementations should call onProgress(0..100, msg)
     * periodically so the UI can show feedback.
     */
    async transcribe(_audioPath, _onProgress) {
        throw new Error("transcribe() not implemented");
    }
}
