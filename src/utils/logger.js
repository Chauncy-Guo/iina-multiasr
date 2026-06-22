/**
 * utils/logger.js -- Thin OSD/log wrapper for the IINA plugin runtime.
 *
 * Messages are written to the IINA developer console (visible via
 * "Help -- Open Plugin Log Folder") AND pushed to the on-screen OSD
 * when level is "info" or higher.
 */

const PREFIX = "[MultiASR]";

function emit(level, msg) {
    const line = `${PREFIX} ${msg}`;
    // Avoid the "console[level] is not a function" path: in webview
    // console.log is a real function but console.info/warn/error are
    // not, so fall back to console.log unconditionally.
    try { console.log(line); } catch (_) {}
    // Show user-visible OSD for warn/error only; info-level lines
    // are otherwise too chatty in the OSD.
    if (level === "warn" || level === "error") {
        try {
            if (iina?.core?.osd) iina.core.osd(line);
        } catch (_) { /* ignore */ }
    }
}

export const log = {
    info:  (m) => emit("log",   `[INFO]  ${m}`),
    warn:  (m) => emit("warn",  `[WARN]  ${m}`),
    error: (m) => emit("error", `[ERROR] ${m}`),
    debug: (m) => { try { console.log(`${PREFIX} [DEBUG] ${m}`); } catch (_) {} },
};
