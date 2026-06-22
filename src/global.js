// global.js -- Global entry, runs in IINA's main process context.
//
// All ASR / translation work happens in the webview (via dist/index.js
// registered as a subtitle provider). This global entry is kept only
// because Info.json requires `globalEntry` to point to a real file.
// If we ever need to spawn long-running native processes (e.g. for
// streaming ASR that survives navigation), we'll wire them up here.

(function globalEntry() {
    // Mark this global entry as loaded; the real value is on `globalThis`
    // so the webview entry (dist/index.js) can detect it during startup.
    try {
        globalThis.__multiasrGlobalLoaded = true;
        if (typeof iina !== "undefined" && iina && iina.console) {
            iina.console.log("MultiASR: global entry loaded");
        } else if (typeof console !== "undefined" && console && console.log) {
            console.log("MultiASR: global entry loaded (no iina.console)");
        }
    } catch (e) {
        // Never throw on load: an empty / throwing global script makes
        // IINA refuse to register the subtitle provider.
    }
})();

