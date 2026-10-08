"use strict";

const net = require("net");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { TCP_PORT, PROTOCOL, DEFAULT_KEEPALIVE_SECONDS } = require("./constants");
const {
    encodeConnect,
    encodePythonHello,
    encodeControl,
    encodeDataFrame,
    decryptFrame,
    FrameDecoder
} = require("./frame");
const { encodeRpc, decodeRpcPayload, rpcFailure } = require("./commands");
const { normalizeStatus, statusFromDps } = require("./status");

const DEFAULT_HELLO_TIMEOUT = 4000;
const DEFAULT_REQUEST_TIMEOUT = 8000;
const DEFAULT_PING_INTERVAL = 10000;

class RoborockClient extends EventEmitter {
    constructor(options) {
        super();
        if (!options || !options.host) {
            throw new Error("Device IP is required");
        }
        if (!options.localKey) {
            throw new Error("Device local key is required");
        }
        this.host = options.host;
        this.port = options.port || TCP_PORT;
        this.localKey = String(options.localKey);
        this.duid = options.duid || "";
        this.protocolPreference = options.protocol || "auto";
        this.knownProtocol = options.knownProtocol || options.pv || "";
        this.protocolMemory = options.protocolMemory || null;
        this.helloTimeoutMs = options.helloTimeoutMs || DEFAULT_HELLO_TIMEOUT;
        this.requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT;
        this.pingIntervalMs = options.pingIntervalMs === undefined ? DEFAULT_PING_INTERVAL : options.pingIntervalMs;
        this.keepAliveSeconds = options.keepAliveSeconds || DEFAULT_KEEPALIVE_SECONDS;
        this.log = options.log || (() => {});
        this.socket = null;
        this.connectedAt = 0;
        this.decoder = new FrameDecoder();
        this.closed = false;
        this.ready = false;
        this.version = null;
        this.connectNonce = null;
        this.ackNonce = null;
        this.pendingHello = null;
        this.pending = new Map();
        this.connectPromise = null;
        this.pingTimer = null;
        this.reconnectTimer = null;
        this.pollTimer = null;
        this.pollMs = 0;
        this.backoffMs = 1000;
        this.requestId = 10000;
        this.seq = 1;
        this.lastStatus = null;
        this.helloStyle = null;
    }

    /**
     * Auto tries the version that worked last time, else the account's pv, else 1.0, and then
     * the other one. The account pv is only a hint: some firmware (an S8 Pro Ultra, a51)
     * reports 1.0 but answers only L01 locally. A forced protocol is never second-guessed.
     */
    versionsToTry() {
        if (this.protocolPreference === "1.0" || this.protocolPreference === "L01") {
            return [this.protocolPreference];
        }
        const remembered = this.protocolMemory ? this.protocolMemory.get() : null;
        const first = [remembered, this.knownProtocol].find((value) => value === "1.0" || value === "L01") || "1.0";
        return [first, first === "1.0" ? "L01" : "1.0"];
    }

    connect() {
        if (this.closed) {
            return Promise.reject(new Error("Client is closed"));
        }
        if (this.ready) {
            return Promise.resolve();
        }
        if (this.connectPromise) {
            return this.connectPromise;
        }
        this.connectPromise = this._connect().finally(() => {
            this.connectPromise = null;
        });
        return this.connectPromise;
    }

    async _connect() {
        const versions = this.versionsToTry();
        let lastError = null;
        for (const version of versions) {
            for (const style of ["app", "python"]) {
                try {
                    await this.openSocket();
                    await this.handshake(version, style);
                    this.version = version;
                    this.helloStyle = style;
                    if (this.protocolMemory && this.protocolPreference === "auto") {
                        this.protocolMemory.set(version);
                    }
                    this.ready = true;
                    this.connectedAt = Date.now();
                    this.backoffMs = 1000;
                    this.startPing();
                    this.log("debug", `connected ${this.host} protocol ${version} (${style} hello)`);
                    this.emit("ready", { version, style });
                    this.refreshStatus().catch((err) => {
                        this.log("debug", `initial status failed: ${err.message}`);
                    });
                    return;
                } catch (err) {
                    lastError = err;
                    this.log("debug", `${version} ${style} hello failed: ${err.message}`);
                    this.destroySocket();
                }
            }
        }
        const error = lastError || new Error("Handshake failed");
        this.emit("failure", error);
        if (!this.closed) {
            this.scheduleReconnect();
        }
        throw error;
    }

    openSocket() {
        this.destroySocket();
        this.decoder.clear();
        return new Promise((resolve, reject) => {
            const socket = net.connect({ host: this.host, port: this.port });
            const onError = (err) => {
                socket.removeListener("connect", onConnect);
                socket.destroy();
                reject(err);
            };
            const onConnect = () => {
                socket.removeListener("error", onError);
                socket.on("error", (err) => this.onSocketError(err));
                socket.on("close", () => this.onSocketClose());
                socket.on("data", (chunk) => this.onData(chunk));
                this.socket = socket;
                resolve();
            };
            socket.once("error", onError);
            socket.once("connect", onConnect);
        });
    }

    handshake(version, style) {
        this.connectNonce = crypto.randomInt(10000, 32767);
        this.ackNonce = null;
        const frame = style === "python"
            ? encodePythonHello({
                version,
                seq: 1,
                random: this.connectNonce,
                timestamp: Math.floor(Date.now() / 1000)
            })
            : encodeConnect({ version, connectNonce: this.connectNonce, keepAlive: this.keepAliveSeconds });
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingHello = null;
                reject(new Error(`No CONNACK for ${version} (${style})`));
            }, this.helloTimeoutMs);
            this.pendingHello = {
                style,
                resolve: (frameInfo) => {
                    clearTimeout(timer);
                    this.pendingHello = null;
                    const code = frameInfo.extra;
                    if (style === "app" && code !== null && code !== 0) {
                        reject(new Error(`Vacuum rejected the handshake (code ${code})`));
                        return;
                    }
                    this.ackNonce = frameInfo.random;
                    resolve(frameInfo);
                },
                reject: (err) => {
                    clearTimeout(timer);
                    this.pendingHello = null;
                    reject(err);
                }
            };
            this.socket.write(frame);
        });
    }

    onData(chunk) {
        let frames;
        try {
            frames = this.decoder.push(chunk);
        } catch (err) {
            this.log("warn", err.message);
            this.destroySocket();
            this.onSocketClose();
            return;
        }
        for (const frame of frames) {
            try {
                this.onFrame(frame);
            } catch (err) {
                this.log("warn", err.message);
            }
        }
    }

    onFrame(frame) {
        if (frame.kind === "control" && frame.protocol === PROTOCOL.CONNACK && this.pendingHello) {
            this.pendingHello.resolve(frame);
            return;
        }
        if (frame.kind === "control") {
            return;
        }
        let plain;
        try {
            plain = decryptFrame(frame, {
                localKey: this.localKey,
                connectNonce: this.connectNonce,
                ackNonce: this.ackNonce
            });
        } catch (err) {
            this.log("warn", `decrypt failed (local key may have changed): ${err.message}`);
            return;
        }
        if (frame.protocol === PROTOCOL.PUBLISH || frame.protocol === 6 || frame.protocol === 7) {
            this.sendPubAck(frame);
        }
        const decoded = decodeRpcPayload(plain);
        if (decoded.rpc && decoded.rpc.id !== undefined) {
            const id = Number(decoded.rpc.id);
            const waiter = this.pending.get(id);
            if (waiter) {
                clearTimeout(waiter.timer);
                this.pending.delete(id);
                const failure = rpcFailure(decoded.rpc);
                if (failure) {
                    waiter.reject(failure);
                } else {
                    waiter.resolve(decoded.rpc.result === undefined ? null : decoded.rpc.result);
                }
            }
        }
        const fromResult = decoded.rpc ? normalizeStatus(decoded.rpc.result) : null;
        const fromDps = statusFromDps(decoded.dps);
        const status = fromResult && fromResult.state !== null ? fromResult : fromDps;
        if (status && (status.state !== null || status.battery !== null)) {
            this.lastStatus = { ...(this.lastStatus || {}), ...stripNulls(status), raw: status.raw || (this.lastStatus && this.lastStatus.raw) };
            this.emit("status", this.lastStatus);
        }
    }

    sendPubAck(frame) {
        if (!this.socket) {
            return;
        }
        try {
            this.socket.write(encodeControl({
                version: frame.version || this.version || "1.0",
                seq: frame.seq,
                protocol: PROTOCOL.PUBACK
            }));
        } catch (err) {
            this.log("debug", `puback failed: ${err.message}`);
        }
    }

    request(method, params, timeoutMs) {
        const timeout = timeoutMs || this.requestTimeoutMs;
        return this.connect().then(() => new Promise((resolve, reject) => {
            const id = this.nextRequestId();
            const seq = this.nextSeq();
            const random = crypto.randomInt(1, 0x7fffffff);
            const timestamp = Math.floor(Date.now() / 1000);
            let frame;
            try {
                frame = encodeDataFrame({
                    version: this.version || "1.0",
                    seq,
                    random,
                    timestamp,
                    protocol: PROTOCOL.PUBLISH,
                    payload: encodeRpc({ id, method, params, timestamp }),
                    localKey: this.localKey,
                    connectNonce: this.connectNonce,
                    ackNonce: this.ackNonce
                });
            } catch (err) {
                reject(err);
                return;
            }
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`No response to ${method} after ${timeout}ms. Check the local key, IP, and that TCP 58867 is reachable.`));
            }, timeout);
            this.pending.set(id, { resolve, reject, timer, method });
            this.socket.write(frame);
        }));
    }

    refreshStatus() {
        return this.request("get_status", []).then((result) => {
            const status = normalizeStatus(result);
            if (status) {
                this.lastStatus = status;
                this.emit("status", status);
            }
            return status;
        });
    }

    setPollInterval(ms) {
        this.pollMs = ms > 0 ? ms : 0;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.pollMs > 0 && !this.closed) {
            this.pollTimer = setInterval(() => {
                if (!this.ready) {
                    return;
                }
                this.refreshStatus().catch((err) => {
                    this.log("debug", `poll failed: ${err.message}`);
                });
            }, this.pollMs);
            if (typeof this.pollTimer.unref === "function") {
                this.pollTimer.unref();
            }
        }
    }

    stopPing() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    startPing() {
        this.stopPing();
        if (!this.pingIntervalMs || this.pingIntervalMs <= 0) {
            return;
        }
        // The CONNECT frame promises traffic at least every keepAliveSeconds. Pinging at exactly
        // that period races the robot's own timeout, so ping at half of it at the latest.
        const intervalMs = Math.min(this.pingIntervalMs, Math.floor(this.keepAliveSeconds * 500));
        this.pingTimer = setInterval(() => {
            if (!this.socket || !this.ready) {
                return;
            }
            try {
                this.socket.write(encodeControl({
                    version: this.version || "1.0",
                    protocol: PROTOCOL.PING
                }));
            } catch (err) {
                this.log("debug", `ping failed: ${err.message}`);
            }
        }, intervalMs);
        if (typeof this.pingTimer.unref === "function") {
            this.pingTimer.unref();
        }
    }

    nextRequestId() {
        this.requestId += 1;
        if (this.requestId > 32767) {
            this.requestId = 10000;
        }
        return this.requestId;
    }

    nextSeq() {
        const current = this.seq;
        this.seq = current >= 65535 ? 1 : current + 1;
        return current;
    }

    onSocketError(err) {
        this.log("debug", `socket error: ${err.message}`);
    }

    onSocketClose() {
        const wasReady = this.ready;
        const uptimeMs = this.connectedAt ? Date.now() - this.connectedAt : 0;
        this.ready = false;
        this.socket = null;
        this.stopPing();
        this.rejectAll(new Error("Connection closed"));
        if (this.pendingHello) {
            this.pendingHello.reject(new Error("Connection closed during handshake"));
        }
        if (this.closed) {
            return;
        }
        if (wasReady || !this.connectPromise) {
            const via = wasReady && this.version
                ? ` after ${(uptimeMs / 1000).toFixed(1)}s on ${this.version} (${this.helloStyle} hello)`
                : "";
            this.scheduleReconnect(via);
        }
    }

    scheduleReconnect(detail = "") {
        if (this.closed || this.reconnectTimer) {
            return;
        }
        const delay = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, 30000);
        this.log("warn", `connection lost${detail}, reconnecting in ${delay}ms`);
        this.emit("disconnect");
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect().catch((err) => {
                this.log("warn", `reconnect failed: ${err.message}`);
                this.scheduleReconnect();
            });
        }, delay);
        if (typeof this.reconnectTimer.unref === "function") {
            this.reconnectTimer.unref();
        }
    }

    rejectAll(err) {
        for (const waiter of this.pending.values()) {
            clearTimeout(waiter.timer);
            waiter.reject(err);
        }
        this.pending.clear();
    }

    destroySocket() {
        const socket = this.socket;
        this.socket = null;
        this.ready = false;
        this.stopPing();
        if (socket) {
            socket.removeAllListeners();
            socket.on("error", () => {});
            socket.destroy();
        }
    }

    close() {
        this.closed = true;
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.rejectAll(new Error("Client closed"));
        if (this.pendingHello) {
            this.pendingHello.reject(new Error("Client closed"));
        }
        this.destroySocket();
        this.removeAllListeners();
    }
}

function stripNulls(status) {
    const copy = { ...status };
    for (const key of Object.keys(copy)) {
        if (copy[key] === null) {
            delete copy[key];
        }
    }
    return copy;
}

module.exports = { RoborockClient };
