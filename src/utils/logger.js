/**
 * utils/logger.js ¡ª Thin OSD/log wrapper for the IINA plugin runtime.
 *
 * Messages are written to the IINA developer console (visible via
 * "Help ¡ú Open Plugin Log Folder") AND pushed to the on-screen OSD
 * when level is "info" or higher.
 */

const PREFIX = "[MultiASR]";

function emit(level, msg) {
    const line = `${PREFIX} ${msg}`;
    // Always log to console
    try { console[level]?.(line) ?? console.log(line); } catch (_) {}
    // Show user-visible OSD for info/warn/error
    if (level === "log") return;
    try {
        if (iina?.core?.osd) {
            iina.core.osd(line);
        }
    } catch (_) { /* ignore */ }
}

export const log = {
    info:  (m) => emit("log",   `[INFO]  ${m}`),
    warn:  (m) => emit("warn",  `[WARN]  ${m}`),
    error: (m) => emit("error", `[ERROR] ${m}`),
    debug: (m) => { try { console.log(`${PREFIX} [DEBUG] ${m}`); } catch (_) {} },
};
