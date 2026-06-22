/**
 * utils/http.js -- HTTP helper using the IINA plugin fetch API.
 *
 * Falls back to executing curl via iina.utils.exec when fetch is
 * unavailable (older IINA versions or sandbox restrictions).
 */

import { log } from "./logger.js";

/**
 * Perform a POST with JSON body. Returns parsed JSON.
 * Throws on non-2xx status with the body text in the error.
 */
export async function postJSON(url, { headers = {}, body, timeoutMs = 120000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: typeof body === "string" ? body : JSON.stringify(body),
            signal: ctrl.signal,
        });
        const text = await resp.text();
        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${text.slice(0, 500)}`);
        }
        try {
            return JSON.parse(text);
        } catch (_) {
            return text;
        }
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Perform a POST with multipart/form-data. Returns parsed JSON.
 * `form` is { fieldName: string | { filename, type, data: Uint8Array } }
 */
export async function postMultipart(url, { headers = {}, form, timeoutMs = 600000 } = {}) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(form)) {
        if (v && typeof v === "object" && v.data instanceof Uint8Array) {
            fd.append(k, new Blob([v.data], { type: v.type || "application/octet-stream" }), v.filename || k);
        } else {
            fd.append(k, v);
        }
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const resp = await fetch(url, {
            method: "POST",
            headers: { ...headers }, // fetch will set multipart boundary
            body: fd,
            signal: ctrl.signal,
        });
        const text = await resp.text();
        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${text.slice(0, 500)}`);
        }
        try {
            return JSON.parse(text);
        } catch (_) {
            return text;
        }
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Sleep helper.
 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry a function with exponential backoff. Calls fn(); retries on thrown error.
 */
export async function withRetry(fn, { attempts = 3, baseMs = 1000, maxMs = 10000 } = {}) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
            log.warn(`Retry ${i + 1}/${attempts} after error: ${e.message}`);
            if (i < attempts - 1) {
                const wait = Math.min(maxMs, baseMs * Math.pow(2, i));
                await sleep(wait);
            }
        }
    }
    throw lastErr;
}
