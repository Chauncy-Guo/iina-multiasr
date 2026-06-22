// global.js -- Global entry, runs in IINA's main process context.
//
// All ASR / translation work happens in the webview (via dist/index.js
// registered as a subtitle provider). This global entry is kept only
// because Info.json requires `globalEntry` to point to a real file.
//
// If we ever need to spawn long-running native processes (e.g. for
// streaming ASR that survives navigation), we'll wire them up here.

export function activate() {
    // Reserved for future native-side setup.
}

export function deactivate() {
    // Reserved for future native-side teardown.
}

// Self-reference so bundlers don't tree-shake this file to zero bytes.
export const __globalEntry = { activate, deactivate };
