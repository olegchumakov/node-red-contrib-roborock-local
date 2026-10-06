"use strict";

const crypto = require("crypto");
const { SALT, A01_HASH, B01_HASH } = require("./constants");

/**
 * Scramble a unix timestamp the way the Roborock V1 key schedule does.
 * hex(ts) zero-padded to 8 chars, then reordered by [5,6,3,7,1,2,0,4].
 */
function encodeTimestamp(timestamp) {
    const hex = (timestamp >>> 0).toString(16).padStart(8, "0");
    const order = [5, 6, 3, 7, 1, 2, 0, 4];
    let out = "";
    for (const index of order) {
        out += hex[index];
    }
    return Buffer.from(out, "utf8");
}

function md5(buffer) {
    return crypto.createHash("md5").update(buffer).digest();
}

function md5Hex(value) {
    return crypto.createHash("md5").update(value).digest("hex");
}

function v1Key(localKey, timestamp) {
    return md5(Buffer.concat([
        encodeTimestamp(timestamp),
        Buffer.from(String(localKey), "utf8"),
        SALT
    ]));
}

function l01Key(localKey, timestamp) {
    return crypto.createHash("sha256").update(Buffer.concat([
        encodeTimestamp(timestamp),
        Buffer.from(String(localKey), "utf8"),
        SALT
    ])).digest();
}

function u32(value) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(value >>> 0, 0);
    return buf;
}

function l01Iv(timestamp, nonce, sequence) {
    const digest = crypto.createHash("sha256")
        .update(Buffer.concat([u32(sequence), u32(nonce), u32(timestamp)]))
        .digest();
    return digest.subarray(0, 12);
}

function l01Aad(timestamp, nonce, sequence, connectNonce, ackNonce) {
    const parts = [u32(sequence), u32(connectNonce)];
    if (ackNonce !== undefined && ackNonce !== null) {
        parts.push(u32(ackNonce));
    }
    parts.push(u32(nonce), u32(timestamp));
    return Buffer.concat(parts);
}

function encryptEcb(plaintext, key) {
    if (!plaintext || plaintext.length === 0) {
        return Buffer.alloc(0);
    }
    const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
    return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptEcb(ciphertext, key) {
    if (!ciphertext || ciphertext.length === 0) {
        return Buffer.alloc(0);
    }
    const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function encryptGcm(plaintext, key, iv, aad) {
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([encrypted, cipher.getAuthTag()]);
}

function decryptGcm(payload, key, iv, aad) {
    if (!payload || payload.length < 16) {
        throw new Error("Invalid L01 payload");
    }
    const tag = payload.subarray(payload.length - 16);
    const ciphertext = payload.subarray(0, payload.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function asciiIvFromMd5(seed, start, end) {
    return Buffer.from(md5Hex(seed).slice(start, end), "utf8");
}

function aesKey(localKey) {
    const key = Buffer.from(String(localKey), "utf8");
    if (key.length !== 16 && key.length !== 24 && key.length !== 32) {
        throw new Error("Local key must be 16, 24, or 32 bytes for this protocol version");
    }
    return key;
}

/**
 * Encrypt a publish payload.
 * version "1.0" is AES-128-ECB with a timestamp-derived key.
 * "L01" is AES-256-GCM. "A01" and "B01" are AES-CBC variants used by some models.
 */
function encryptPayload(plaintext, options) {
    const version = options.version || "1.0";
    if (version === "1.0") {
        return encryptEcb(plaintext, v1Key(options.localKey, options.timestamp));
    }
    if (version === "L01") {
        const key = l01Key(options.localKey, options.timestamp);
        const iv = l01Iv(options.timestamp, options.nonce, options.sequence);
        const aad = l01Aad(
            options.timestamp,
            options.nonce,
            options.sequence,
            options.connectNonce,
            options.ackNonce
        );
        return encryptGcm(plaintext, key, iv, aad);
    }
    if (version === "A01") {
        const iv = asciiIvFromMd5(`${(options.nonce >>> 0).toString(16).padStart(8, "0")}${A01_HASH}`, 8, 24);
        const cipher = crypto.createCipheriv("aes-128-cbc", aesKey(options.localKey), iv);
        cipher.setAutoPadding(false);
        const padded = pkcs7Pad(plaintext);
        return Buffer.concat([cipher.update(padded), cipher.final()]);
    }
    if (version === "B01") {
        const iv = asciiIvFromMd5(`${(options.nonce >>> 0).toString(16).padStart(8, "0")}${B01_HASH}`, 9, 25);
        const cipher = crypto.createCipheriv("aes-128-cbc", aesKey(options.localKey), iv);
        return Buffer.concat([cipher.update(plaintext), cipher.final()]);
    }
    throw new Error(`Unsupported protocol version ${version}`);
}

function decryptPayload(ciphertext, options) {
    const version = options.version || "1.0";
    if (version === "1.0") {
        return decryptEcb(ciphertext, v1Key(options.localKey, options.timestamp));
    }
    if (version === "L01") {
        const key = l01Key(options.localKey, options.timestamp);
        const iv = l01Iv(options.timestamp, options.nonce, options.sequence);
        const aad = l01Aad(
            options.timestamp,
            options.nonce,
            options.sequence,
            options.connectNonce,
            options.ackNonce
        );
        return decryptGcm(ciphertext, key, iv, aad);
    }
    if (version === "A01") {
        const iv = asciiIvFromMd5(`${(options.nonce >>> 0).toString(16).padStart(8, "0")}${A01_HASH}`, 8, 24);
        const decipher = crypto.createDecipheriv("aes-128-cbc", aesKey(options.localKey), iv);
        decipher.setAutoPadding(false);
        const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return pkcs7Unpad(padded);
    }
    if (version === "B01") {
        const iv = asciiIvFromMd5(`${(options.nonce >>> 0).toString(16).padStart(8, "0")}${B01_HASH}`, 9, 25);
        const decipher = crypto.createDecipheriv("aes-128-cbc", aesKey(options.localKey), iv);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    }
    throw new Error(`Unsupported protocol version ${version}`);
}

function pkcs7Pad(buffer) {
    const size = 16;
    const pad = size - (buffer.length % size || size);
    return Buffer.concat([buffer, Buffer.alloc(pad === 0 ? size : pad, pad === 0 ? size : pad)]);
}

function pkcs7Unpad(buffer) {
    if (!buffer.length) {
        return buffer;
    }
    const pad = buffer[buffer.length - 1];
    if (pad < 1 || pad > 16) {
        return buffer;
    }
    return buffer.subarray(0, buffer.length - pad);
}

module.exports = {
    encodeTimestamp,
    md5,
    md5Hex,
    v1Key,
    l01Key,
    l01Iv,
    l01Aad,
    encryptEcb,
    decryptEcb,
    encryptGcm,
    decryptGcm,
    encryptPayload,
    decryptPayload
};
