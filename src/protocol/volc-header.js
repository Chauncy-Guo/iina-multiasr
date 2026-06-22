/**
 * protocol/volc-header.js -- Binary protocol for Doubao (Volc) Seed ASR 2.0.
 *
 * Mirrors the Python reference at
 *   reference/doubao-asr/doubao_asr.py
 *
 * Frame layout (per VolcHeader.swift, 4-byte header + 4-byte BE size + payload):
 *
 *   [ 4-byte header | (4-byte seq if flag 0x1/0x3) | 4-byte BE size | payload ]
 *
 * Header byte layout (4 bits each):
 *   byte 0:  [ version | header_size (in 4-byte units) ]
 *   byte 1:  [ msg_type | flags ]
 *   byte 2:  [ serialization | compression ]
 *   byte 3:  reserved (0)
 *
 * Verified end-to-end with the user's APP_ID/Token on 2026-06-22.
 */

export const MessageType = {
    FULL_CLIENT_REQUEST: 0x1,
    AUDIO_ONLY_REQUEST:  0x2,
    SERVER_RESPONSE:     0x9,
    SERVER_ERROR:        0xF,
};

export const Flags = {
    NO_SEQUENCE:            0x0,
    POSITIVE_SEQUENCE:      0x1,
    LAST_PACKET_NO_SEQ:     0x2,
    NEGATIVE_SEQUENCE_LAST: 0x3,
};

export const Serialization = {
    NONE: 0x0,
    JSON: 0x1,
};

export const Compression = {
    NONE: 0x0,
    GZIP: 0x1,
};

const VERSION = 0x1;
const HEADER_SIZE_UNITS = 0x1;   // 1 unit = 4 bytes total

/**
 * Build a 4-byte Volc header.
 *   byte0 = (version << 4) | header_size_units
 *   byte1 = (msg_type << 4) | flags
 *   byte2 = (serialization << 4) | compression
 *   byte3 = 0
 */
export function encodeHeader({ msgType, flags = 0, serialization = 0, compression = 0 } = {}) {
    if (msgType < 0 || msgType > 0x0F) throw new Error(`msgType out of range: ${msgType}`);
    if (flags    < 0 || flags    > 0x0F) throw new Error(`flags out of range: ${flags}`);
    const byte0 = ((VERSION & 0x0F) << 4) | (HEADER_SIZE_UNITS & 0x0F);
    const byte1 = ((msgType & 0x0F) << 4) | (flags & 0x0F);
    const byte2 = ((serialization & 0x0F) << 4) | (compression & 0x0F);
    return new Uint8Array([byte0, byte1, byte2, 0]);
}

/**
 * Build a full frame: header + (optional seq) + 4-byte BE size + payload.
 * When flags are POSITIVE_SEQUENCE (0x1) or NEGATIVE_SEQUENCE_LAST (0x3),
 * seq must be provided (4-byte BE int).
 */
export function buildFrame({ msgType, flags = 0, serialization = 0, compression = 0, seq, payload }) {
    const header = encodeHeader({ msgType, flags, serialization, compression });
    const data = payload || new Uint8Array(0);
    const needSeq = (flags === 0x1 || flags === 0x3);
    const seqBytes = needSeq ? new Uint8Array(4) : null;
    if (needSeq) {
        if (seq == null) throw new Error("seq required for POSITIVE/NEGATIVE_SEQUENCE flags");
        new DataView(seqBytes.buffer).setUint32(0, seq >>> 0, false);
    }
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, data.length, false);
    const out = new Uint8Array(header.length + (seqBytes ? 4 : 0) + size.length + data.length);
    let off = 0;
    out.set(header, off); off += header.length;
    if (seqBytes) { out.set(seqBytes, off); off += 4; }
    out.set(size, off); off += size.length;
    out.set(data, off);
    return out;
}

/**
 * Parse a Volc binary frame from `data` at `offset`.
 * Returns null if there aren't enough bytes for a complete frame.
 * Returns { header, payload, consumed } on success.
 */
export function parseFrame(data, offset = 0) {
    if (data.length - offset < 4) return null;
    const b0 = data[offset + 0];
    const b1 = data[offset + 1];
    const b2 = data[offset + 2];
    const version = (b0 >> 4) & 0x0F;
    const headerSizeUnits = b0 & 0x0F;
    const msgType = (b1 >> 4) & 0x0F;
    const flags = b1 & 0x0F;
    const serialization = (b2 >> 4) & 0x0F;
    const compression = b2 & 0x0F;
    const headerSize = headerSizeUnits * 4;
    let off = offset + headerSize;
    if (off > data.length) return null;
    let seq = null;
    if (flags === 0x1 || flags === 0x3) {
        if (data.length - off < 4) return null;
        seq = new DataView(data.buffer, data.byteOffset + off, 4).getUint32(0, false);
        off += 4;
    }
    if (data.length - off < 4) return null;
    const payloadSize = new DataView(data.buffer, data.byteOffset + off, 4).getUint32(0, false);
    off += 4;
    if (data.length - off < payloadSize) return null;
    const payload = data.subarray(off, off + payloadSize);
    return {
        header: { version, msgType, flags, serialization, compression, payloadSize, seq },
        payload,
        consumed: (off + payloadSize) - offset,
    };
}
