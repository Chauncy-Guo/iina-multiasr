/**
 * providers/doubao.js -- ByteDance Doubao Seed ASR 2.0 provider.
 *
 * Verified end-to-end with the user's APP_ID/Token on 2026-06-22.
 *
 * Binary WebSocket protocol (see src/protocol/volc-header.js for details):
 *   - 4-byte header | (4-byte seq if flag 0x1/0x3) | 4-byte BE size | payload
 *
 * Flow:
 *   1. open WebSocket with auth headers
 *   2. send FULL_CLIENT_REQUEST (JSON: user/audio/request config)
 *   3. stream audio chunks as AUDIO_ONLY_REQUEST at realtime pace
 *   4. receive SERVER_RESPONSE frames with JSON:
 *        { result: { text, utterances: [{start_time, end_time, text}, ...] },
 *          is_last: bool }
 *   5. send empty AUDIO_ONLY_REQUEST with LAST flag, then wait for
 *      SERVER_ERROR (type=0x0F) frame which signals session end.
 *
 * Empirically the server requires realtime-ish pacing (20ms between
 * 100ms chunks). Burst-sending produces zero results.
 */

import { BaseASRProvider, ASRError } from "./base.js";
import {
    buildFrame,
    parseFrame,
    MessageType,
    Serialization,
    Compression,
} from "../protocol/volc-header.js";
import { cuesToSRT, parseSRT } from "../subtitle/srt.js";
import { log } from "../utils/logger.js";

const FLAG_LAST_PACKET_NO_SEQ = 0x02;

// Realtime pacing: CHUNK = 100ms of 16kHz mono 16-bit PCM, sent every
// 20ms. This keeps the server's VAD happy and matches Python reference.
const AUDIO_CHUNK_BYTES = 3200;
const AUDIO_SEND_INTERVAL_MS = 20;

export class DoubaoASRProvider extends BaseASRProvider {
    constructor(config) {
        super(config);
        this.providerName = "doubao";
    }

    validateCredentials() {
        if (!this.config.appId || !this.config.accessToken) {
            throw new ASRError("Doubao App ID and Access Token are required", {
                provider: "doubao",
                code: "AUTH_MISSING",
            });
        }
    }

    async listModels() {
        this.validateCredentials();
        return [
            {
                id: "doubao-seed-asr-2.0",
                name: "Doubao Seed ASR 2.0 (bigmodel)",
                description:
                    "ByteDance streaming ASR over WebSocket with utterance-level timestamps",
            },
        ];
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

        const wsUrl =
            this.config.endpoint ||
            "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";

        // WKWebView's WebSocket constructor doesn't allow custom
        // headers, so we encode auth as sub-protocols. The server's
        // gateway accepts this for the SAUC endpoint.
        const subProtocols = [
            `X-Api-App-Key=${this.config.appId}`,
            `X-Api-Access-Key=${this.config.accessToken}`,
            `X-Api-Resource-Id=${
                this.config.resourceId || "volc.seedasr.sauc.duration"
            }`,
            `X-Api-Connect-Id=${uuidv4()}`,
        ];

        const ws = await openWebSocket(wsUrl, subProtocols);

        try {
            onProgress(15, "Sending handshake...");
            await sendHandshake(ws, this.config);

            // Start receiving in the background. Server pushes
            // incremental text + utterances as audio is processed.
            const receiver = new ResponseCollector(ws);
            const recvPromise = receiver.start();

            // Stream audio at realtime pace
            onProgress(20, "Streaming audio...");
            const total = audioBytes.length;
            for (let off = 0; off < total; off += AUDIO_CHUNK_BYTES) {
                const slice = audioBytes.subarray(
                    off,
                    Math.min(off + AUDIO_CHUNK_BYTES, total),
                );
                ws.send(
                    buildFrame({
                        msgType: MessageType.AUDIO_ONLY_REQUEST,
                        flags: 0x00,
                        serialization: Serialization.NO_SERIALIZATION,
                        compression: Compression.NONE,
                        payload: slice,
                    }).buffer,
                );
                const pct = 20 + Math.floor((off / total) * 60);
                onProgress(pct, `Streaming audio (${off}/${total} bytes)...`);
                await sleep(AUDIO_SEND_INTERVAL_MS);
            }

            onProgress(82, "Finalizing...");
            // Empty AUDIO_ONLY_REQUEST with LAST flag
            ws.send(
                buildFrame({
                    msgType: MessageType.AUDIO_ONLY_REQUEST,
                    flags: FLAG_LAST_PACKET_NO_SEQ,
                    serialization: Serialization.NO_SERIALIZATION,
                    compression: Compression.NONE,
                    payload: new Uint8Array(0),
                }).buffer,
            );

            // Wait for server-side session end (type=0x0F frame).
            // Receiver resolves on session_end or socket close.
            const result = await recvPromise;

            onProgress(95, "Formatting SRT...");

            // Prefer utterances (per-segment with start/end times).
            // Fall back to the full incremental text wrapped in a
            // single cue if the model didn't emit utterances.
            const cues = result.utterances.length
                ? result.utterances.map((u) => ({
                      start: Math.max(0, Math.floor((u.start_time || 0))),
                      end: Math.max(
                          Math.floor((u.start_time || 0)) + 500,
                          Math.floor((u.end_time || 0)),
                      ),
                      text: (u.text || "").trim(),
                  })).filter((c) => c.text)
                : (() => {
                      const txt = (result.text || "").trim();
                      if (!txt) return [];
                      // No timestamps ¡ú wrap full text in a single cue
                      // covering the whole file. IINA will still show it.
                      return [{ start: 0, end: 86400000, text: txt }];
                  })();

            if (!cues.length) {
                throw new ASRError(
                    `Doubao returned empty transcript (frames=${result.frameCount}, utterances=${result.utterances.length})`,
                    { provider: "doubao", code: "EMPTY_RESPONSE" },
                );
            }

            onProgress(100, "Transcription complete");
            return cuesToSRT(cues);
        } finally {
            try {
                ws.close();
            } catch (_) {}
        }
    }
}

// ---- helpers ------------------------------------------------------------

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function uuidv4() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
}

function openWebSocket(url, subProtocols) {
    return new Promise((resolve, reject) => {
        let ws;
        try {
            ws =
                subProtocols && subProtocols.length
                    ? new WebSocket(url, subProtocols)
                    : new WebSocket(url);
        } catch (e) {
            reject(
                new ASRError(
                    `Failed to open WebSocket: ${e.message}`,
                    { provider: "doubao", cause: e },
                ),
            );
            return;
        }
        const t = setTimeout(() => {
            try {
                ws.close();
            } catch (_) {}
            reject(
                new ASRError("Doubao WebSocket connect timeout", {
                    provider: "doubao",
                    code: "WS_TIMEOUT",
                }),
            );
        }, 15000);

        ws.onopen = () => {
            clearTimeout(t);
            resolve(ws);
        };
        ws.onerror = (e) => {
            clearTimeout(t);
            reject(
                new ASRError(
                    `Doubao WebSocket error: ${
                        e?.message || e?.toString() || "unknown"
                    }`,
                    { provider: "doubao", code: "WS_ERROR" },
            );
        };
    });
}

async function sendHandshake(ws, cfg) {
    // Match the verified Python reference payload.
    const payload = {
        user: { uid: uuidv4() },
        audio: {
            format: "pcm",
            codec: "raw",
            rate: 16000,
            bits: 16,
            channel: 1,
        },
        request: {
            model_name: "bigmodel",
            enable_punc: true,
            enable_ddc: true,
            enable_nonstream: true,
            show_utterances: true,
            result_type: "full",
            end_window_size: 3000,
            force_to_speech_time: 0,
        },
    };
    if (cfg.hotwords) payload.request.hotwords = cfg.hotwords;

    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    ws.send(
        buildFrame({
            msgType: MessageType.FULL_CLIENT_REQUEST,
            flags: 0x00,
            serialization: Serialization.JSON,
            compression: Compression.NONE,
            payload: bytes,
        }).buffer,
    );
}

/**
 * Background collector that:
 *   - parses incoming binary frames
 *   - extracts the latest cumulative text and the latest utterances list
 *   - resolves on SERVER_ERROR (type 0x0F) or socket close
 */
class ResponseCollector {
    constructor(ws) {
        this.ws = ws;
        this.text = "";
        this.utterances = []; // latest server snapshot (overwritten)
        this.frameCount = 0;
        this.buffer = new Uint8Array(0);
        this._resolve = null;
        this._reject = null;
        this._closed = false;
    }

    start() {
        return new Promise((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;

            this.ws.onmessage = (ev) => {
                if (this._closed) return;
                this._handleMessage(ev);
            };
            this.ws.onerror = (e) => {
                if (this._closed) return;
                this._closed = true;
                this._reject(
                    new ASRError(
                        `WebSocket error: ${
                            e?.message || e?.toString() || "unknown"
                        }`,
                        { provider: "doubao", code: "WS_ERROR" },
                    ),
                );
            };
            this.ws.onclose = (e) => {
                if (this._closed) return;
                this._closed = true;
                // Server may close after sending all results.
                this._resolve({
                    text: this.text,
                    utterances: this.utterances,
                    frameCount: this.frameCount,
                });
            };
        });
    }

    async _handleMessage(ev) {
        try {
            let data;
            if (ev.data instanceof ArrayBuffer) {
                data = new Uint8Array(ev.data);
            } else if (ev.data instanceof Blob) {
                data = new Uint8Array(await ev.data.arrayBuffer());
            } else {
                data = new Uint8Array(await ev.data.arrayBuffer());
            }
            // append
            const tmp = new Uint8Array(this.buffer.length + data.length);
            tmp.set(this.buffer, 0);
            tmp.set(data, this.buffer.length);
            this.buffer = tmp;

            let off = 0;
            while (true) {
                const f = parseFrame(this.buffer, off);
                if (!f) break;
                off += f.consumed;
                this._processFrame(f);
            }
            if (off > 0) this.buffer = this.buffer.subarray(off);
        } catch (e) {
            if (!this._closed) {
                this._closed = true;
                this._reject(
                    new ASRError(
                        `Failed to parse Doubao frame: ${e.message}`,
                        { provider: "doubao", cause: e },
                    ),
                );
            }
        }
    }

    _processFrame(frame) {
        this.frameCount++;
        const { msgType, serialization } = frame.header;
        if (msgType === MessageType.SERVER_ERROR) {
            // type=0x0F signals end of session per Volc docs.
            const payload = decodeJSONOrText(frame.payload);
            log("info", `Doubao session end: ${JSON.stringify(payload || {}).slice(0, 200)}`);
            this._closed = true;
            this._resolve({
                text: this.text,
                utterances: this.utterances,
                frameCount: this.frameCount,
            });
            return;
        }
        if (serialization !== Serialization.JSON) return;
        const json = decodeJSONOrText(frame.payload);
        if (!json) return;
        const r = json.result || {};
        if (typeof r.text === "string" && r.text.length) {
            this.text = r.text;
        }
        if (Array.isArray(r.utterances) && r.utterances.length) {
            // Overwrite with the latest snapshot; server is
            // authoritative for the complete segment list.
            this.utterances = r.utterances.map((u) => ({
                start_time: Number(u.start_time || 0),
                end_time: Number(u.end_time || 0),
                text: String(u.text || ""),
            }));
        }
    }
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
    if (!resp.ok) {
        throw new ASRError(
            `Failed to read audio file: ${resp.status}`,
            { provider: "doubao", code: "FILE_READ" },
        );
    }
    const buf = await resp.arrayBuffer();
    return new Uint8Array(buf);
}
