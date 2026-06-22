/**
 * subtitle/srt.js -- Build & parse SRT subtitle strings.
 *
 * SRT format:
 *   1
 *   00:00:00,000 --> 00:00:02,000
 *   Hello world
 *
 *   2
 *   ...
 */

function pad(n, w = 2) { return String(n).padStart(w, "0"); }

export function formatTimestamp(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const ms = Math.round(seconds * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const milli = ms % 1000;
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
}

/**
 * Convert an array of cue objects to an SRT string.
 * cues: [{ start: seconds, end: seconds, text: string }]
 */
export function cuesToSRT(cues) {
    return cues
        .filter(c => c && c.text && c.text.trim())
        .map((c, i) => {
            return `${i + 1}\n${formatTimestamp(c.start)} --> ${formatTimestamp(c.end)}\n${c.text.trim()}\n`;
        })
        .join("\n");
}

/**
 * Parse an SRT string into cue objects.
 */
export function parseSRT(srt) {
    const blocks = srt.replace(/\r\n/g, "\n").split(/\n\n+/);
    const cues = [];
    for (const block of blocks) {
        const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
        if (lines.length < 2) continue;
        let i = 0;
        // Skip numeric index line
        if (/^\d+$/.test(lines[0])) i = 1;
        const m = lines[i]?.match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
        if (!m) continue;
        cues.push({
            start: parseTimestamp(m[1]),
            end:   parseTimestamp(m[2]),
            text:  lines.slice(i + 1).join("\n"),
        });
    }
    return cues;
}

function parseTimestamp(ts) {
    const [h, m, s] = ts.split(":");
    const [sec, ms] = s.split(/[,.]/);
    return (+h) * 3600 + (+m) * 60 + (+sec) + (+ms) / 1000;
}
