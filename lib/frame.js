"use strict";

const { crc32 } = require("./crc32");
const { encryptPayload, decryptPayload, decryptEcb } = require("./crypto");
const { BROADCAST_TOKEN, PROTOCOL, DEFAULT_KEEPALIVE_SECONDS } = require("./constants");

const CONTROL_PROTOCOLS = new Set([
    PROTOCOL.CONNECT,
    PROTOCOL.CONNACK,
    PROTOCOL.PING,
    PROTOCOL.PONG,
    PROTOCOL.PUBACK
]);

function writeHeader(body, { version, seq, random, timestamp, protocol }) {
    const ver = Buffer.from(version, "ascii");
    if (ver.length !== 3) {
        throw new Error("Protocol version must be 3 bytes");
    }
    ver.copy(body, 0);
    body.writeUInt32BE(seq >>> 0, 3);
    body.writeUInt32BE(random >>> 0, 7);
    body.writeUInt32BE(timestamp >>> 0, 11);
    body.writeUInt16BE(protocol, 15);
}

function prefixLength(body) {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(body.length, 0);
    return Buffer.concat([prefix, body]);
}

/**
 * App-style CONNECT. 17-byte header plus a 4-byte keepalive. No CRC.
 * The random field is the connect nonce the vacuum echoes back in CONNACK.
 */
function encodeConnect({ version = "1.0", connectNonce, keepAlive = DEFAULT_KEEPALIVE_SECONDS }) {
    const body = Buffer.alloc(21);
    writeHeader(body, {
        version,
        seq: 0,
        random: connectNonce,
        timestamp: 0,
        protocol: PROTOCOL.CONNECT
    });
    body.writeUInt32BE(keepAlive >>> 0, 17);
    return prefixLength(body);
}

/**
 * Hello frame produced by python-roborock's generic builder: header plus CRC, no keepalive.
 * Some firmware accepts this when the app-style CONNECT is ignored.
 */
function encodePythonHello({ version = "1.0", seq = 1, random, timestamp }) {
    const body = Buffer.alloc(21);
    writeHeader(body, {
        version,
        seq,
        random,
        timestamp,
        protocol: PROTOCOL.CONNECT
    });
    body.writeUInt32BE(crc32(body.subarray(0, 17)), 17);
    return prefixLength(body);
}

function encodeControl({ version = "1.0", seq = 0, random = 0, timestamp = 0, protocol, extra }) {
    const body = Buffer.alloc(extra === undefined || extra === null ? 17 : 21);
    writeHeader(body, { version, seq, random, timestamp, protocol });
    if (extra !== undefined && extra !== null) {
        body.writeUInt32BE(extra >>> 0, 17);
    }
    return prefixLength(body);
}

function encodeDataFrame({
    version = "1.0",
    seq,
    random,
    timestamp,
    protocol = PROTOCOL.PUBLISH,
    payload,
    localKey,
    connectNonce,
    ackNonce
}) {
    const plain = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const encrypted = encryptPayload(plain, {
        version,
        localKey,
        timestamp,
        nonce: random,
        sequence: seq,
        connectNonce,
        ackNonce
    });
    const body = Buffer.alloc(19 + encrypted.length + 4);
    writeHeader(body, { version, seq, random, timestamp, protocol });
    body.writeUInt16BE(encrypted.length, 17);
    encrypted.copy(body, 19);
    body.writeUInt32BE(crc32(body.subarray(0, body.length - 4)), body.length - 4);
    return prefixLength(body);
}

function parseBody(body) {
    if (body.length < 17) {
        throw new Error("Frame is shorter than a header");
    }
    const version = body.toString("ascii", 0, 3);
    const seq = body.readUInt32BE(3);
    const random = body.readUInt32BE(7);
    const timestamp = body.readUInt32BE(11);
    const protocol = body.readUInt16BE(15);
    const base = { version, seq, random, timestamp, protocol };

    if (body.length === 17) {
        return { ...base, kind: "control", extra: null, payload: null };
    }
    if (body.length === 21 && CONTROL_PROTOCOLS.has(protocol)) {
        return { ...base, kind: "control", extra: body.readUInt32BE(17), payload: null };
    }
    if (body.length < 23) {
        return { ...base, kind: "control", extra: body.length > 17 ? body.readUInt32BE(17) : null, payload: null };
    }

    const payloadLen = body.readUInt16BE(17);
    const expected = 19 + payloadLen + 4;
    if (expected !== body.length) {
        throw new Error(`Frame length ${body.length} does not match payload length ${payloadLen}`);
    }
    const crcExpect = body.readUInt32BE(body.length - 4);
    const crcActual = crc32(body.subarray(0, body.length - 4));
    if (crcExpect !== crcActual) {
        throw new Error("CRC mismatch");
    }
    return {
        ...base,
        kind: "data",
        encrypted: body.subarray(19, 19 + payloadLen)
    };
}

function decryptFrame(frame, options) {
    if (frame.kind !== "data") {
        return null;
    }
    return decryptPayload(frame.encrypted, {
        version: frame.version,
        localKey: options.localKey,
        timestamp: frame.timestamp,
        nonce: frame.random,
        sequence: frame.seq,
        connectNonce: options.connectNonce,
        ackNonce: options.ackNonce
    });
}

class FrameDecoder {
    constructor() {
        this.buf = Buffer.alloc(0);
    }

    push(chunk) {
        this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
        const frames = [];
        while (this.buf.length >= 4) {
            const len = this.buf.readUInt32BE(0);
            if (len < 17 || len > 1024 * 1024) {
                this.buf = this.buf.subarray(1);
                continue;
            }
            if (this.buf.length < 4 + len) {
                break;
            }
            const body = this.buf.subarray(4, 4 + len);
            this.buf = this.buf.subarray(4 + len);
            frames.push(parseBody(body));
        }
        return frames;
    }

    clear() {
        this.buf = Buffer.alloc(0);
    }
}

function decodeBroadcast(datagram) {
    if (!datagram || datagram.length < 15) {
        return null;
    }
    const version = datagram.toString("ascii", 0, 3);
    if (version === "L01") {
        return decodeL01Broadcast(datagram);
    }
    if (version === "1.0" || version === "A01" || version === "B01") {
        return decodeClassicBroadcast(datagram);
    }
    return null;
}

function decodeClassicBroadcast(datagram) {
    const payloadLen = datagram.readUInt16BE(9);
    const end = 11 + payloadLen;
    if (datagram.length < end + 4) {
        throw new Error("Truncated discovery packet");
    }
    const expected = datagram.readUInt32BE(end);
    if (crc32(datagram.subarray(0, end)) !== expected) {
        throw new Error("Discovery CRC mismatch");
    }
    const plain = decryptEcb(datagram.subarray(11, end), BROADCAST_TOKEN);
    const json = JSON.parse(stripPadding(plain).toString("utf8"));
    return {
        duid: json.duid,
        ip: json.ip,
        version: datagram.toString("ascii", 0, 3)
    };
}

function decodeL01Broadcast(datagram) {
    const payloadLen = datagram.readUInt16BE(9);
    const end = 11 + payloadLen;
    if (datagram.length < end + 4) {
        throw new Error("Truncated L01 discovery packet");
    }
    if (crc32(datagram.subarray(0, end)) !== datagram.readUInt32BE(end)) {
        throw new Error("Discovery CRC mismatch");
    }
    const crypto = require("crypto");
    const payload = datagram.subarray(11, end);
    const key = crypto.createHash("sha256").update(BROADCAST_TOKEN).digest();
    const iv = crypto.createHash("sha256").update(datagram.subarray(0, 9)).digest().subarray(0, 12);
    const tag = payload.subarray(payload.length - 16);
    const ciphertext = payload.subarray(0, payload.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const json = JSON.parse(plain.toString("utf8"));
    return { duid: json.duid, ip: json.ip, version: "L01" };
}

function stripPadding(buffer) {
    if (!buffer.length) {
        return buffer;
    }
    const pad = buffer[buffer.length - 1];
    if (pad < 1 || pad > 16) {
        return buffer;
    }
    for (let i = 0; i < pad; i += 1) {
        if (buffer[buffer.length - 1 - i] !== pad) {
            return buffer;
        }
    }
    return buffer.subarray(0, buffer.length - pad);
}

module.exports = {
    encodeConnect,
    encodePythonHello,
    encodeControl,
    encodeDataFrame,
    parseBody,
    decryptFrame,
    FrameDecoder,
    decodeBroadcast
};
