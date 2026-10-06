"use strict";

/**
 * IEEE CRC-32, matching Python binascii.crc32 / zlib.crc32.
 * Implemented locally so Node 18 (no zlib.crc32) and Node 22 agree.
 */
const TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i += 1) {
        c = TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
}

module.exports = { crc32 };
