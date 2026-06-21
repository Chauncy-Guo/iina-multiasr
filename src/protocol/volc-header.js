/**
 * protocol/volc-header.js ¡ª Binary protocol for Doubao Seed ASR 2.0.
 *
 * Mirrors the Python reference at
 *   reference/doubao-asr/doubao_asr.py
 * Each frame is:
 *
 *   [ 4-byte header | 4-byte payload size (big-endian) | payload ]
 *
 * The header layout is bit-packed as follows (see VolcHeader docs):
 *
 *   byte 0:  [ 1 bit  version | 3 bits  header_size | 4 bits  msg_type_high ]
 *   byte 1:  [ 4 bits  msg_type_low | 1 bit  msg_flags | 2 bits  serial | 1 bit  compress ]
 *   byte 2:  [ 8 bits  reserved ]
 *   byte 3:  [ 8 bits  reserved ]
 *
 * The Python reference uses this trick:
 *   byte0 = (version << 3) | (header_size & 0x07) | (msg_type & 0x0F)
 *   byte1 = (msg_type >> 4) | (flags << 4) | (serialization << 1) | compress
 * We replicate the same encoding.
 */

export const MessageType = {
    FULL_CLIENT_REQUEST: 0x01,
    AUDIO_ONLY_REQUEST:  0x02,
    SERVER_RESPONSE:     0x09,
    SERVER_ERROR:        0x0F,
};

export const Serialization = {
    NO_SERIALIZATION: 0x0,
    JSON:             0x1,
    // custom/thrift not used here
};

export const Compression = {
    NONE: 0,
    GZIP: 1,
};

const VERSION = 0x1;          // protocol version (4 bits)
const HEADER_SIZE = 0x1;      // in 4-byte words => 4 bytes total (3 bits)

/**
 * Encode a 4-byte Volc header.
 */
export function encodeHeader({ msgType, flags = 0, serialization = Serialization.JSON, compression = Compression.NONE } = {}) {
    if (msgType < 0 || msgType > 0x0F) {
        // msg_type is 8 bits split across two nibbles
        if (msgType < 0 || msgType > 0xFF) {
            throw new Error(`msgType out of range: ${msgType}`);
        }
    }
    const byte0 = ((VERSION & 0x01) << 3) | (HEADER_SIZE & 0x07) | ((msgType & 0x0F) << 4) >> 4;
    // The Python reference packs msg_type like:
    //   byte0 = (version << 3) | (header_size & 0x07) | ((msgType & 0x0F) << 4)
    //   byte1 = ((msgType >> 4) & 0x0F) | (flags << 4) | (serialization << 1) | compression
    //   byte2 = 0
    //   byte3 = 0
    // Re-derived:
    const b0 = ((VERSION & 0x01) << 3) | (HEADER_SIZE & 0x07) | ((msgType & 0x0F) << 4);
    const b1 = ((msgType >> 4) & 0x0F) | ((flags & 0x0F) << 4) | ((serialization & 0x03) << 1) | (compression & 0x01);
    return new Uint8Array([b0, b1, 0, 0]);
}

/**
 * Build a full frame: header + 4-byte BE size + payload.
 */
export function buildFrame(opts) {
    const header = encodeHeader(opts);
    const payload = opts.payload || new Uint8Array(0);
    const size = new Uint8Array(4);
    const view = new DataView(size.buffer);
    view.setUint32(0, payload.length, false); // big-endian
    const out = new Uint8Array(header.length + size.length + payload.length);
    out.set(header, 0);
    out.set(size, header.length);
    out.set(payload, header.length + size.length);
    return out;
}

/**
 * Decode a 4-byte header. Returns { msgType, flags, serialization, compression, raw }.
 */
export function decodeHeader(bytes) {
    if (bytes.length < 4) throw new Error("header too short");
    const b0 = bytes[0], b1 = bytes[1];
    const version     = (b0 >> 3) & 0x01;
    const headerSize  = (b0 & 0x07) + 1; // in 4-byte words
    const msgTypeLow  = (b0 >> 4) & 0x0F;
    const msgTypeHigh = b1 & 0x0F;
    const msgType     = (msgTypeHigh << 4) | msgTypeLow;
    const flags       = (b1 >> 4) & 0x0F;
    const serialization = (b1 >> 1) & 0x03;
    const compression = b1 & 0x01;
    return { version, headerSize, msgType, flags, serialization, compression, raw: bytes.slice(0, 4) };
}

/**
 * Parse the next frame from a buffer. Returns { frame, consumed } or null.
 * The frame includes its 4-byte header and 4-byte size prefix.
 */
export function parseFrame(buf, offset = 0) {
    if (buf.length - offset < 8) return null;
    const view = new DataView(buf.buffer, buf.byteOffset + offset, 8);
    const size = view.getUint32(4, false);
    if (buf.length - offset < 8 + size) return null;
    return {
        frame: buf.subarray(offset, offset + 8 + size),
        header: decodeHeader(buf.subarray(offset, offset + 4)),
        payload: buf.subarray(offset + 8, offset + 8 + size),
        consumed: 8 + size,
    };
}
