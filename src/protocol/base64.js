/**
 * protocol/base64.js ?? Standard base64 encode/decode for binary payloads.
 *
 * The IINA plugin webview is a WKWebView, which exposes btoa/atob but
 * they only operate on Latin-1 strings. We use a binary-safe variant.
 */

const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeBase64(uint8) {
    if (uint8 instanceof ArrayBuffer) uint8 = new Uint8Array(uint8);
    let out = "";
    let i = 0;
    for (; i + 2 < uint8.length; i += 3) {
        const a = uint8[i], b = uint8[i + 1], c = uint8[i + 2];
        out += b64[a >> 2] + b64[((a & 3) << 4) | (b >> 4)] +
               b64[((b & 15) << 2) | (c >> 6)] + b64[c & 63];
    }
    if (i < uint8.length) {
        const a = uint8[i];
        const b = (i + 1 < uint8.length) ? uint8[i + 1] : 0;
        out += b64[a >> 2] + b64[((a & 3) << 4) | (b >> 4)];
        out += (i + 1 < uint8.length) ? b64[(b & 15) << 2] : "=";
        out += "=";
    }
    return out;
}

export function decodeBase64(str) {
    const cleaned = str.replace(/[^A-Za-z0-9+/=]/g, "");
    const out = new Uint8Array(Math.floor(cleaned.length * 3 / 4));
    let p = 0;
    for (let i = 0; i < cleaned.length; i += 4) {
        const a = b64.indexOf(cleaned[i]);
        const b = b64.indexOf(cleaned[i + 1]);
        const c = b64.indexOf(cleaned[i + 2]);
        const d = b64.indexOf(cleaned[i + 3]);
        out[p++] = (a << 2) | (b >> 4);
        if (cleaned[i + 2] !== "=") out[p++] = ((b & 15) << 4) | (c >> 2);
        if (cleaned[i + 3] !== "=") out[p++] = ((c & 3) << 6) | d;
    }
    return out;
}
