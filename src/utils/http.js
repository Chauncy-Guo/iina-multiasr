/**
 * utils/http.js -- HTTP helper using curl via iina.utils.exec.
 *
 * IINA's WKWebView doesn't expose fetch(), and iina.http has
 * version-dependent behavior. We use curl directly for reliability.
 */

import { log } from "./logger.js";
import { execCapture } from "./fs-shim.js";

/**
 * Perform a POST with JSON body. Returns parsed JSON.
 * Throws on non-2xx status with the body text in the error.
 */
export async function postJSON(url, { headers = {}, body, timeoutMs = 120000 } = {}) {
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    const headerArgs = [];
    for (const [k, v] of Object.entries({ "Content-Type": "application/json", ...headers })) {
        headerArgs.push("-H", `${k}: ${v}`);
    }

    // Write body to a temp file to avoid shell quoting issues
    const bodyFile = `/tmp/multiasr_body_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`;
    const respFile = `/tmp/multiasr_resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`;
    const codeFile = `/tmp/multiasr_code_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`;

    try {
        // Write body to temp file
        iina.file.write(bodyFile, bodyStr);

        // Execute curl, capture HTTP status code and body
        const curlCmd = [
            "/usr/bin/curl",
            "-s", "-S",                    // silent but show errors
            "-w", "\\n%{http_code}",       // append HTTP status code
            "--max-time", String(Math.ceil(timeoutMs / 1000)),
            "-X", "POST",
            ...headerArgs,
            "-d", `@${bodyFile}`,
            "-o", respFile,
            url,
        ].map(shellEscape).join(" ");

        await execCapture("/bin/sh", "-c", `${curlCmd} > '${codeFile}' 2>&1`);

        // Read response body
        const { stdout: respText } = await execCapture("/bin/cat", respFile);
        // Read HTTP status code (last line of curl output)
        const { stdout: codeText } = await execCapture("/bin/cat", codeFile);
        const httpCode = parseInt(codeText.trim().split("\n").pop(), 10) || 0;

        if (httpCode < 200 || httpCode >= 300) {
            throw new Error(`HTTP ${httpCode}: ${respText.slice(0, 500)}`);
        }

        try {
            return JSON.parse(respText);
        } catch (_) {
            return respText;
        }
    } finally {
        // Cleanup temp files
        try {
            await execCapture("/bin/rm", "-f", bodyFile, respFile, codeFile);
        } catch (_) {}
    }
}

/**
 * Perform a POST with multipart/form-data. Returns parsed JSON.
 * `form` is { fieldName: string | { filename, type, data: Uint8Array } }
 */
export async function postMultipart(url, { headers = {}, form, timeoutMs = 600000 } = {}) {
    const args = [];
    for (const [k, v] of Object.entries(form)) {
        if (v && typeof v === "object" && v.data instanceof Uint8Array) {
            // Binary data: write to temp file then use curl -F file=@tmpfile
            const tmpBin = `/tmp/multiasr_bin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            iina.file.write(tmpBin, String.fromCharCode.apply(null, v.data));
            args.push("-F", `${k}=@${tmpBin};type=${v.type || "application/octet-stream"}`);
        } else {
            args.push("-F", `${k}=${String(v)}`);
        }
    }

    const headerArgs = [];
    for (const [k, v] of Object.entries(headers)) {
        headerArgs.push("-H", `${k}: ${v}`);
    }

    const respFile = `/tmp/multiasr_resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`;
    const codeFile = `/tmp/multiasr_code_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`;

    try {
        const curlArgs = [
            "/usr/bin/curl",
            "-s", "-S",
            "-w", "\\n%{http_code}",
            "--max-time", String(Math.ceil(timeoutMs / 1000)),
            "-X", "POST",
            ...headerArgs,
            ...args,
            "-o", respFile,
            url,
        ];

        await execCapture("/bin/sh", "-c", curlArgs.map(shellEscape).join(" ") + ` > '${codeFile}' 2>&1`);

        const { stdout: respText } = await execCapture("/bin/cat", respFile);
        const { stdout: codeText } = await execCapture("/bin/cat", codeFile);
        const httpCode = parseInt(codeText.trim().split("\n").pop(), 10) || 0;

        if (httpCode < 200 || httpCode >= 300) {
            throw new Error(`HTTP ${httpCode}: ${respText.slice(0, 500)}`);
        }

        try {
            return JSON.parse(respText);
        } catch (_) {
            return respText;
        }
    } finally {
        try {
            await execCapture("/bin/rm", "-f", respFile, codeFile);
        } catch (_) {}
    }
}

function shellEscape(s) {
    if (typeof s !== "string") s = String(s);
    // Use single quotes, escaping any embedded single quotes
    return "'" + s.replace(/'/g, "'\\''") + "'";
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
