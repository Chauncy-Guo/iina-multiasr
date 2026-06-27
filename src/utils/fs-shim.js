/**
 * utils/fs-shim.js -- Async filesystem ops usable in both the IINA
 * plugin webview (no `fs`, no Node Buffer) and a plain Node test
 * environment.
 *
 * IINA's webview (WKWebView) does not expose `fs` globally, but it
 * does provide `iina.utils.exec(cmd, args[])`. We wrap that into
 * a Promise-returning fs API so the rest of the codebase can be
 * tested with real Node fs and run inside IINA unchanged.
 *
 * In IINA webview, uses iina.file.read/write and iina.file.handle
 * for file I/O. Avoids TextEncoder/TextDecoder/btoa which are
 * unavailable in IINA's WKWebView.
 */

const isIINA = (() => {
    try { return typeof iina !== "undefined" && !!iina?.utils?.exec; }
    catch (_) { return false; }
})();
// We hide every Node reference inside new Function() so that the
// webview/Parcel pass doesn't see a top-level `process` or
// `require` and refuse to bundle. The lazy `getNodeFS()` returns
// null in the webview, so those code paths are never executed
// there.

// Lazy node fs/promises loader. We hide all Node access behind
// new Function() so the bundler never sees `process`/`require` and
// can keep this file browser-friendly. In the webview, isIINA is
// true so getNodeFS() is never called.
let _nodeFS = null;
function getNodeFS() {
    if (_nodeFS) return _nodeFS;
    if (!isIINA && typeof globalThis.process === "undefined") return null;
    try {
        // eslint-disable-next-line no-new-func
        const req = new Function(
            "const proc = (typeof process !== 'undefined') ? process : null;"
            + "if (!proc || !proc.versions || !proc.versions.node) return null;"
            + "if (proc.getBuiltinModule) {"
            + "  return proc.getBuiltinModule('module')"
            + "    .createRequire((proc.cwd() + '/_'))('fs/promises');"
            + "}"
            + "try { return proc.binding('fs'); } catch(e) {}"
            + "try { return require('fs/promises'); } catch(e) {}"
            + "return null;"
        )();
        _nodeFS = req || null;
        return _nodeFS;
    } catch (_) {
        return null;
    }
}

function shellEscape(s) {
    // Wrap in single quotes; replace embedded ' with '\''
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

async function _iinaExec(cmd, ...args) {
    // Guarded accessor so this module is loadable in pure Node tests
    // (where the IINA global doesn't exist).
    if (!isIINA) throw new Error("iina.utils.exec is not available outside IINA");
    // IINA's utils.exec(file, args[]) expects args as an array, not spread.
    return iina.utils.exec(cmd, args);
}

/**
 * Execute a command and capture its stdout + exit code directly via
 * iina.utils.exec's return value. No temp files, no recursion.
 */
export async function execCapture(cmd, ...args) {
    const { status, stdout, stderr } = await _iinaExec(cmd, ...args);
    return { code: status, stdout: stdout || "", stderr: stderr || "" };
}

export async function readFile(p, enc = "utf-8") {
    const fs = getNodeFS();
    if (fs) return fs.readFile(p, enc);
    // In IINA, use iina.file.read() for text files.
    // iina.file.read() reads as UTF-8 string natively, works fine.
    if (isIINA) {
        return iina.file.read(p);
    }
    const { code, stdout } = await execCapture("/bin/cat", p);
    if (code !== 0) throw new Error(`readFile failed: ${p}`);
    return stdout;
}

export async function writeFile(p, content, enc = "utf-8") {
    const fs = getNodeFS();
    if (fs) return fs.writeFile(p, content, enc);
    if (isIINA) {
        // Strategy: convert string -> UTF-8 bytes -> base64,
        // then use printf + base64 -D via shell to write the file.
        // This avoids iina.file.write entirely (which corrupts data).
        const bytes = stringToUtf8Bytes(content);
        const b64 = uint8ToBase64(bytes);
        // Split base64 into chunks to avoid shell ARG_MAX limits.
        // macOS ARG_MAX is ~256KB; typical SRT is well under that,
        // but we chunk at 64KB for safety.
        const chunkSize = 65000;
        const chunks = [];
        for (let i = 0; i < b64.length; i += chunkSize) {
            chunks.push(b64.slice(i, i + chunkSize));
        }
        // For small content, use single printf command
        if (chunks.length === 1) {
            const { code } = await execCapture(
                "/bin/sh", "-c",
                `printf '%s' ${shellEscape(b64)} | /usr/bin/base64 -D > ${shellEscape(p)}`,
            );
            if (code !== 0) throw new Error(`writeFile failed: ${p}`);
            return;
        }
        // For large content, write base64 to temp file via printf chunks,
        // then decode. We use multiple printf >> to append.
        const tmpFile = "/tmp/multiasr_w_" + Date.now() + ".b64";
        for (let i = 0; i < chunks.length; i++) {
            const op = i === 0 ? ">" : ">>";
            const { code } = await execCapture(
                "/bin/sh", "-c",
                `printf '%s' ${shellEscape(chunks[i])} ${op} ${shellEscape(tmpFile)}`,
            );
            if (code !== 0) throw new Error(`writeFile chunk failed`);
        }
        const { code } = await execCapture(
            "/bin/sh", "-c",
            `/usr/bin/base64 -D < ${shellEscape(tmpFile)} > ${shellEscape(p)}`,
        );
        try { await execCapture("/bin/rm", "-f", tmpFile); } catch (_) {}
        if (code !== 0) throw new Error(`writeFile failed: ${p}`);
        return;
    }
    throw new Error(`writeFile failed: no fs available for ${p}`);
}

/**
 * Convert a JS string to a Uint8Array of UTF-8 bytes.
 * Works without TextEncoder (which is unavailable in IINA webview).
 */
function stringToUtf8Bytes(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
        let cp = str.charCodeAt(i);
        // Handle surrogate pairs for characters beyond BMP
        if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < str.length) {
            const next = str.charCodeAt(i + 1);
            if (next >= 0xDC00 && next <= 0xDFFF) {
                cp = ((cp - 0xD800) << 10) + (next - 0xDC00) + 0x10000;
                i++;
            }
        }
        if (cp < 0x80) {
            bytes.push(cp);
        } else if (cp < 0x800) {
            bytes.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F));
        } else if (cp < 0x10000) {
            bytes.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
        } else {
            bytes.push(
                0xF0 | (cp >> 18),
                0x80 | ((cp >> 12) & 0x3F),
                0x80 | ((cp >> 6) & 0x3F),
                0x80 | (cp & 0x3F),
            );
        }
    }
    return new Uint8Array(bytes);
}

/**
 * Convert a Uint8Array of UTF-8 bytes to a JS string.
 * Works without TextDecoder (which is unavailable in IINA webview).
 */
function utf8BytesToString(bytes) {
    let result = "";
    let i = 0;
    while (i < bytes.length) {
        const b0 = bytes[i];
        let cp, n;
        if (b0 < 0x80) {
            cp = b0; n = 1;
        } else if ((b0 & 0xE0) === 0xC0) {
            cp = b0 & 0x1F; n = 2;
        } else if ((b0 & 0xF0) === 0xE0) {
            cp = b0 & 0x0F; n = 3;
        } else if ((b0 & 0xF8) === 0xF0) {
            cp = b0 & 0x07; n = 4;
        } else {
            // Invalid leading byte, skip
            i++; continue;
        }
        for (let j = 1; j < n; j++) {
            if (i + j >= bytes.length || (bytes[i + j] & 0xC0) !== 0x80) {
                cp = -1; break;
            }
            cp = (cp << 6) | (bytes[i + j] & 0x3F);
        }
        if (cp < 0) { i++; continue; }
        i += n;
        // Encode as JS string (handle surrogate pairs for codepoints > 0xFFFF)
        if (cp < 0x10000) {
            result += String.fromCharCode(cp);
        } else {
            cp -= 0x10000;
            result += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
        }
    }
    return result;
}

/**
 * Convert a Uint8Array to a base64 string without using btoa()
 * (which is unavailable in IINA webview).
 */
function uint8ToBase64(bytes) {
    const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let result = "";
    const len = bytes.length;
    for (let i = 0; i < len; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < len ? bytes[i + 1] : 0;
        const b2 = i + 2 < len ? bytes[i + 2] : 0;
        result += CHARS[b0 >> 2];
        result += CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
        result += i + 1 < len ? CHARS[((b1 & 0x0F) << 2) | (b2 >> 6)] : "=";
        result += i + 2 < len ? CHARS[b2 & 0x3F] : "=";
    }
    return result;
}

export async function rename(src, dst) {
    const fs = getNodeFS();
    if (fs) return fs.rename(src, dst);
    const { code } = await execCapture("/bin/mv", "-f", src, dst);
    if (code !== 0) throw new Error(`rename failed: ${src} -> ${dst}`);
}

export async function mkdir(p, opts) {
    const fs = getNodeFS();
    if (fs) return fs.mkdir(p, opts);
    const args = opts?.recursive ? ["-p", p] : [p];
    const { code } = await execCapture("/bin/mkdir", ...args);
    if (code !== 0 && code !== 1) throw new Error(`mkdir failed: ${p}`);
}

export async function stat(p) {
    const fs = getNodeFS();
    if (fs) return fs.stat(p);
    const { code, stdout } = await execCapture("/usr/bin/stat", "-f", "%z %HT", p);
    if (code !== 0) {
        const e = new Error(`stat failed: ${p}`);
        e.code = "ENOENT";
        throw e;
    }
    const line = stdout.trim();
    const [sizeStr, ...typeParts] = line.split(" ");
    const size = parseInt(sizeStr, 10) || 0;
    const typ = typeParts.join(" ");
    const isDir = /Directory/i.test(typ);
    return { isDirectory: () => isDir, isFile: () => !isDir, size };
}

export async function unlink(p) {
    const fs = getNodeFS();
    if (fs) return fs.unlink(p);
    const { code } = await execCapture("/bin/rm", "-f", p);
    if (code !== 0) throw new Error(`unlink failed: ${p}`);
}

export async function access(p, mode) {
    const fs = getNodeFS();
    if (fs) return fs.access(p, mode);
    const flag = mode & 2 ? "w" : mode & 4 ? "r" : mode & 1 ? "x" : "e";
    const { code } = await execCapture("/usr/bin/test", `-${flag}`, p);
    if (code !== 0) {
        const e = new Error(`access denied: ${p}`);
        e.code = "EACCES";
        throw e;
    }
}

export const constants = {
    R_OK: 4,
    W_OK: 2,
    X_OK: 1,
    F_OK: 0,
};
