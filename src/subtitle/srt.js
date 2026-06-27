/**
 * subtitle/srt.js -- Build & parse subtitle strings (ASS and SRT).
 *
 * ASS (Advanced SubStation Alpha) is the primary output format because
 * mpv on macOS incorrectly detects encoding for SRT files, causing CJK
 * characters to display as white squares. ASS declares encoding and font
 * explicitly, avoiding this issue entirely.
 *
 * SRT parsing is kept for backward compatibility with cached files.
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

function formatASSTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const ms = Math.round(seconds * 100);
    const h = Math.floor(ms / 360000);
    const m = Math.floor((ms % 360000) / 6000);
    const s = Math.floor((ms % 6000) / 100);
    const cs = ms % 100;
    return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

/**
 * Convert an array of cue objects to an ASS string.
 * Uses Hiragino Sans GB (macOS built-in CJK font) and declares UTF-8
 * encoding so mpv renders CJK characters correctly.
 */
export function cuesToASS(cues, title = "MultiASR") {
    const filtered = cues.filter(c => c && c.text && c.text.trim());
    const header = `[Script Info]
Title: ${title}
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Hiragino Sans GB,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,10,10,30,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
    const events = filtered.map(c => {
        const text = c.text.trim().replace(/\n/g, "\\N");
        return `Dialogue: 0,${formatASSTime(c.start)},${formatASSTime(c.end)},Default,,0,0,0,,${text}`;
    }).join("\n");
    return header + events + "\n";
}

/**
 * Parse an ASS or SRT string into cue objects.
 * Auto-detects format based on content.
 */
export function parseSRT(srt) {
    // Strip UTF-8 BOM if present (U+FEFF)
    if (srt.charCodeAt(0) === 0xFEFF) srt = srt.slice(1);

    // Detect ASS format
    if (srt.includes("[Script Info]") && srt.includes("[Events]")) {
        return parseASS(srt);
    }

    // Parse as SRT
    const blocks = srt.replace(/\r\n/g, "\n").split(/\n\n+/);
    const cues = [];
    for (const block of blocks) {
        const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
        if (lines.length < 2) continue;
        let i = 0;
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

function parseASS(ass) {
    const cues = [];
    const lines = ass.replace(/\r\n/g, "\n").split("\n");
    let inEvents = false;
    for (const line of lines) {
        if (line.trim() === "[Events]") { inEvents = true; continue; }
        if (line.startsWith("[")) { inEvents = false; continue; }
        if (!inEvents || !line.startsWith("Dialogue:")) continue;
        const parts = line.substring(9).split(",");
        if (parts.length < 10) continue;
        const start = parseASSTime(parts[1]);
        const end = parseASSTime(parts[2]);
        const text = parts.slice(9).join(",").replace(/\\N/g, "\n").replace(/\{[^}]*\}/g, "").trim();
        if (text) cues.push({ start, end, text });
    }
    return cues;
}

function parseASSTime(ts) {
    const [h, m, rest] = ts.trim().split(":");
    const [s, cs] = rest.split(".");
    return (+h) * 3600 + (+m) * 60 + (+s) + (+cs) / 100;
}

function parseTimestamp(ts) {
    const [h, m, s] = ts.split(":");
    const [sec, ms] = s.split(/[,.]/);
    return (+h) * 3600 + (+m) * 60 + (+sec) + (+ms) / 1000;
}
