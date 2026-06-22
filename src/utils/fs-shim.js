/**
 * utils/fs-shim.js -- Async filesystem ops usable in both the IINA
 * plugin webview (no `fs`, no Node Buffer) and a plain Node test
 * environment.
 *
 * IINA's webview (WKWebView) does not expose `fs` globally, but it
 * does provide `iina.utils.exec(cmd, ...args)`. We wrap that into
 * a Promise-returning fs API so the rest of the codebase can be
 * tested with real Node fs and run inside IINA unchanged.
 *
 * Browser compatibility: uses only TextEncoder / btoa for base64
 * (avoids `Buffer`, which Parcel would complain about and which
 * isn't in webview anyway).
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
    return iina.utils.exec(cmd, ...args);
}

function utf8ToBase64(content) {
    const bytes = new TextEncoder().encode(content);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

async function execCapture(cmd, ...args) {
    // Capture stdout + exit code by redirecting to temp files.
    const outFile = `/tmp/multiasr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.out`;
    const ecFile = outFile + ".ec";
    const cmdline = `${cmd} ${args.map(shellEscape).join(" ")} > ${shellEscape(outFile)} 2>&1; echo $? > ${shellEscape(ecFile)}`;
    await _iinaExec("/bin/sh", "-c", cmdline);
    const out = (await execRead(outFile));
    const ec = parseInt((await execRead(ecFile)).trim(), 10) || 0;
    try { await _iinaExec("/bin/rm", "-f", outFile, ecFile); } catch (_) {}
    return { code: ec, stdout: out };
}

async function execRead(path) {
    const { stdout } = await execCapture("/bin/cat", path);
    return stdout;
}

export async function readFile(p, enc = "utf-8") {
    const fs = getNodeFS();
    if (fs) return fs.readFile(p, enc);
    const { code, stdout } = await execCapture("/bin/cat", p);
    if (code !== 0) throw new Error(`readFile failed: ${p}`);
    return stdout;
}

export async function writeFile(p, content, enc = "utf-8") {
    const fs = getNodeFS();
    if (fs) return fs.writeFile(p, content, enc);
    // Stream content via base64 to avoid shell quoting issues with
    // SRT body that may contain quotes, backticks, newlines, etc.
    const b64 = utf8ToBase64(content);
    const code = await execCode(
        `/bin/sh -c ${shellEscape(`echo ${b64} | /usr/bin/base64 -d > ${p}`)}`,
    );
    if (code !== 0) throw new Error(`writeFile failed: ${p}`);
}

export async function rename(src, dst) {
    const fs = getNodeFS();
    if (fs) return fs.rename(src, dst);
    const code = await execCode(
        `/bin/sh -c ${shellEscape(`/bin/mv -f '${src}' '${dst}'`)}`,
    );
    if (code !== 0) throw new Error(`rename failed: ${src} -> ${dst}`);
}

export async function mkdir(p, opts) {
    const fs = getNodeFS();
    if (fs) return fs.mkdir(p, opts);
    const flag = opts?.recursive ? "-p" : "";
    const code = await execCode(
        `/bin/sh -c ${shellEscape(`/bin/mkdir ${flag} '${p}'`)}`,
    );
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
    const code = await execCode(
        `/bin/sh -c ${shellEscape(`/bin/rm -f '${p}'`)}`,
    );
    if (code !== 0) throw new Error(`unlink failed: ${p}`);
}

export async function access(p, mode) {
    const fs = getNodeFS();
    if (fs) return fs.access(p, mode);
    const flag = mode & 2 ? "w" : mode & 4 ? "r" : mode & 1 ? "x" : "e";
    const code = await execCode(
        `/bin/sh -c ${shellEscape(`/usr/bin/test -${flag} '${p}'`)}`,
    );
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

async function execCode(cmdline) {
    const ecFile = `/tmp/multiasr_ec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await _iinaExec("/bin/sh", "-c", `${cmdline}; echo $? > ${ecFile}`);
    const text = (await execRead(ecFile)).trim();
    try { await _iinaExec("/bin/rm", "-f", ecFile); } catch (_) {}
    return parseInt(text, 10) || 0;
}
