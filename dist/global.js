/* global.js -- IINA global entry
 *
 * All plugin logic runs in the webview (subtitle provider registered in
 * index.js). This global entry is kept because Info.json declares
 * `globalEntry: "dist/global.js"` and IINA requires the file to exist
 * and be a valid JS module.
 *
 * If you need to spawn native processes or run code in the IINA main
 * process context, add it here.
 */

export function activate() {
    /* no-op */
}

export function deactivate() {
    /* no-op */
}
