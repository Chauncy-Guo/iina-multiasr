/**
 * global.js ¡ª Global entry, runs in IINA's main process context.
 *
 * Currently unused: all logic (HTTP, WebSocket, file I/O) runs in
 * the webview because the plugin permissions include
 * "network-request" and "file-system". If we ever need to spawn
 * long-running native processes (e.g. for streaming ASR that
 * survives navigation), we'll add them here.
 *
 * Required by Info.json: `globalEntry` must point to a real file.
 */

export function activate() {
    // no-op
}

export function deactivate() {
    // no-op
}
