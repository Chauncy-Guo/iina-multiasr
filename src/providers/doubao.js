/**
 * providers/doubao.js ¡ª ByteDance Doubao Seed ASR 2.0 provider.
 *
 * Implements the binary WebSocket protocol from
 *   reference/doubao-asr/doubao_asr.py
 *
 * Frame layout (see protocol/volc-header.js):
 *   [ 4-byte header | 4-byte BE size | payload ]
 *
 * Flow:
 *   1. open WebSocket with auth headers
 *   2. send FULL_CLIENT_REQUEST (JSON payload with user/audio config)
 *   3. stream audio chunks as AUDIO_ONLY_REQUEST frames
 *   4. receive SERVER_RESPONSE frames whose payload is JSON like
 *        { "result": { "text": "..." }, "is_last": false }
 *      The text is cumulative (full transcript so far).
 *   5. when done, send an empty AUDIO_ONLY_REQUEST with the
 *      "no-sequence" / "last packet" flag set, then close.
 *
 * NOTE: the WebSocket runs in the IINA plugin webview, which has
 * native WebSocket support. No need for an external `ws` package.
 */

import { BaseASRProvider, ASRError } from "./base.js";
import { buildFrame, parseFrame, MessageType, Serialization, Compression } from "../protocol/volc-header.js";
import { cuesToSRT } from "../subtitle/srt.js";
import { log } from "../utils/logger.js";

const FLAG_LAST_PACKET_NO_SEQ = 0x02; // see Volc docs

export class DoubaoASRProvider extends BaseASRProvider {
    constructor(config) {
        super(config);
        this.providerName = "doubao";
    }

    validateCredentials() {
        if (!this.config.appId || !this.config.accessToken) {
            throw new ASRError("Doubao App ID and Access Token are required", {
                provider: "doubao", code: "AUTH_MISSING"
            });
        }
    }

    async listModels() {
        this.validateCredentials();
        return [{
            id: "doubao-seed-asr-2.0",
            name: "Doubao Seed ASR 2.0",
            description: "ByteDance streaming ASR (WebSocket)",
        }];
    }

    /**
     * @param {string} audioPath
     * @param {(percent:number, msg:string)=>void} onProgress
     * @returns {Promise<string>} SRT formatted text
     */
    async transcribe(audioPath, onProgress = () => {}) {
        this.validateCredentials();
        onProgress(5, "Reading audio file...");

        const audioBytes = await readFileAsUint8(audioPath);
        onProgress(10, "Opening Doubao WebSocket...");

        // Volc requires several custom headers. WKWebView supports
        // sub-protocols and basic-auth-style subheaders.
        const wsUrl = this.config.endpoint;
        const headers = [
            `X-Api-App-Key: ${this.config.appId}`,
            `X-Api-Access-Key: ${this.config.accessToken}`,
            `X-Api-Resource-Id: ${this.config.resourceId}`,
            `X-Api-Connect-Id: ${uuidv4()}`,
        ];

        // We need to pass headers to WebSocket. WKWebView's WebSocket
        // constructor doesn't support custom headers directly, so we
        // append the auth to the URL fragment as a workaround that
        // Volc's gateway accepts when constructing the session.
        // (Alternative: use a sub-protocol string.)
        const finalUrl = wsUrl; // no headers in WS; rely on app/access keys in URL? ¡ª use sub-protocol.
        const subProtocols = headers.map(h => h.replace(/:\s*/, "="));

        const ws = await openWebSocket(finalUrl, subProtocols);
        try {
            onProgress(15, "Sending handshake...");
            await sendHandshake(ws, this.config);

            onProgress(20, "Streaming audio...");
            // Stream audio in chunks. PCM 16kHz mono 16-bit = 32KB/s.
            // 200ms = 6400 bytes per chunk.
            const CHUNK = 6400;
            const total = audioBytes.length;
            for (let off = 0; off < total; off += CHUNK) {
                const slice = audioBytes.subarray(off, Math.min(off + CHUNK, total));
                ws.send(buildFrame({
                    msgType: MessageType.AUDIO_ONLY_REQUEST,
                    serialization: Serialization.NO_SERIALIZATION,
                    compression: Compression.NONE,
                    payload: slice,
                }).buffer);
                onProgress(20 + Math.floor((off / total) * 60), "Streaming audio...");
                await sleep(1); // tiny backpressure
            }

            // Send LAST packet (empty payload, flag set)
            onProgress(82, "Finalizing...");
            ws.send(buildFrame({
                msgType: MessageType.AUDIO_ONLY_REQUEST,
                serialization: Serialization.NO_SERIALIZATION,
                compression: Compression.NONE,
                flags: FLAG_LAST_PACKET_NO_SEQ,
                payload: new Uint8Array(0),
            }).buffer);

            // Receive all server responses
            const finalText = await collectResponses(ws, onProgress);
            onProgress(98, "Formatting SRT...");

            if (!finalText || !finalText.trim()) {
                throw new ASRError("Doubao returned empty transcript", { provider: "doubao" });
            }
            // We don't have per-cue timing from this API, so we
            // produce a single cue with the full text. IINA will
            // still display the subtitle; the user can later upgrade
            // to a provider that returns segments.
            return cuesToSRT([{ start: 0, end: 86400, text: finalText.trim() }]);
        } finally {
            try { ws.close(); } catch (_) {}
        }
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function uuidv4() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
}

/**
 * Open a WebSocket and resolve when the connection is established.
 * The "subProtocols" trick carries our auth headers because WKWebView
 * doesn't allow custom HTTP headers in the WebSocket constructor.
 */
function openWebSocket(url, subProtocols) {
    return new Promise((resolve, reject) => {
        let ws;
        try {
            ws = subProtocols && subProtocols.length
                ? new WebSocket(url, subProtocols)
                : new WebSocket(url);
        } catch (e) {
            reject(new ASRError(`Failed to open WebSocket: ${e.message}`, { provider: "doubao", cause: e }));
            return;
        }
        const t = setTimeout(() => {
            try { ws.close(); } catch (_) {}
            reject(new ASRError("Doubao WebSocket connect timeout", { provider: "doubao", code: "WS_TIMEOUT" }));
        }, 15000);

        ws.onopen = () => { clearTimeout(t); resolve(ws); };
        ws.onerror = (e) => { clearTimeout(t); reject(new ASRError(`Doubao WebSocket error: ${e?.message || "unknown"}`, { provider: "doubao", code: "WS_ERROR" })); };
        // onclose without onopen: reject
        ws.onclose = (e) => {
            if (e.code !== 1000) { clearTimeout(t); reject(new ASRError(`WebSocket closed: ${e.code} ${e.reason}`, { provider: "doubao" })); }
        };
    });
}

async function sendHandshake(ws, cfg) {
    const payload = {
        user: { uid: uuidv4() },
        audio: {
            format: "pcm_s16le",
            rate: 16000,
            bits: 16,
            channel: 1,
            language: cfg.language || "en",
        },
        request: {
            model_name: "bigmodel",
            enable_itn: true,
            enable_punc: true,
            enable_ddc: true,
            show_utterances: true,
        },
    };
    if (cfg.hotwords) payload.request.hotwords = cfg.hotwords;

    const json = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(json);
    ws.send(buildFrame({
        msgType: MessageType.FULL_CLIENT_REQUEST,
        serialization: Serialization.JSON,
        compression: Compression.NONE,
        payload: bytes,
    }).buffer);
}

async function collectResponses(ws, onProgress) {
    const chunks = [];
    let lastText = "";
    let frameCount = 0;
    let buffer = new Uint8Array(0);

    return new Promise((resolve, reject) => {
        ws.onmessage = async (ev) => {
            try {
                const data = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(await ev.data.arrayBuffer());
                // Append to rolling buffer
                const tmp = new Uint8Array(buffer.length + data.length);
                tmp.set(buffer, 0);
                tmp.set(data, buffer.length);
                buffer = tmp;

                // Parse as many frames as we have
                let off = 0;
                let last;
                while (true) {
                    const f = parseFrame(buffer, off);
                    if (!f) break;
                    off += f.consumed;
                    last = f;
                }
                if (off > 0) buffer = buffer.subarray(off);

                if (!last) return;
                frameCount++;

                // SERVER_ERROR
                if (last.header.msgType === MessageType.SERVER_ERROR) {
                    const errPayload = decodeJSONOrText(last.payload);
                    reject(new ASRError(`Doubao server error: ${JSON.stringify(errPayload)}`, { provider: "doubao", code: "SERVER_ERROR" }));
                    return;
                }

                // Parse JSON payload
                const json = decodeJSONOrText(last.payload);
                if (json && json.result && typeof json.result.text === "string") {
                    lastText = json.result.text;
                    chunks.push(lastText);
                    onProgress(82 + Math.min(13, frameCount), `Recognized ${lastText.length} chars...`);
                }

                // Heuristic: a final frame often arrives after a short pause
                if (json && (json.is_last || json.result?.is_final)) {
                    resolve(lastText);
                }
            } catch (e) {
                reject(new ASRError(`Failed to parse Doubao frame: ${e.message}`, { provider: "doubao", cause: e }));
            }
        };
        ws.onerror = (e) => reject(new ASRError(`WebSocket error: ${e?.message || "unknown"}`, { provider: "doubao" }));
        ws.onclose = (e) => {
            if (e.code !== 1000) {
                // The server may close after sending all results; treat as success
                if (e.code === 1005 || e.code === 1006) {
                    resolve(lastText);
                } else {
                    reject(new ASRError(`WebSocket closed unexpectedly: ${e.code} ${e.reason}`, { provider: "doubao" }));
                }
            } else {
                resolve(lastText);
            }
        };

        // Safety timeout
        setTimeout(() => {
            if (lastText) resolve(lastText);
            else reject(new ASRError("Doubao response timeout", { provider: "douseo", code: "TIMEOUT" }));
        }, 10 * 60 * 1000);
    });
}

function decodeJSONOrText(bytes) {
    if (!bytes || bytes.length === 0) return null;
    try {
        const text = new TextDecoder("utf-8").decode(bytes);
        return JSON.parse(text);
    } catch (_) {
        return null;
    }
}

async function readFileAsUint8(path) {
    const resp = await fetch(`file://${encodeURI(path)}`);
    if (!resp.ok) throw new Error(`Failed to read ${path}: ${resp.status}`);
    const buf = await resp.arrayBuffer();
    return new Uint8Array(buf);
}
