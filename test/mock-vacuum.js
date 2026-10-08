"use strict";

const net = require("net");
const { FrameDecoder, encodeControl, encodeDataFrame, decryptFrame } = require("../lib/frame");
const { decodeRpcPayload, encodeRpcResponse } = require("../lib/commands");
const { PROTOCOL } = require("../lib/constants");

const LOCAL_KEY = "testlocalkey1234";

/**
 * options.versions limits which protocol versions answer the hello (others stay silent, like
 * firmware that does not speak them). Default: any.
 */
function startMock(handler, options = {}) {
    const requests = [];
    const helloVersions = [];
    const sockets = new Set();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        const decoder = new FrameDecoder();
        const session = { version: "1.0", connectNonce: null, ackNonce: null };
        socket.on("data", (chunk) => {
            let frames = [];
            try {
                frames = decoder.push(chunk);
            } catch (_err) {
                return;
            }
            for (const frame of frames) {
                if (frame.kind === "control" && frame.protocol === PROTOCOL.CONNECT) {
                    helloVersions.push(frame.version);
                    if (options.versions && !options.versions.includes(frame.version)) {
                        continue;
                    }
                    session.version = frame.version;
                    session.connectNonce = frame.random;
                    session.ackNonce = 424242;
                    socket.write(encodeControl({
                        version: frame.version,
                        protocol: PROTOCOL.CONNACK,
                        seq: frame.seq,
                        random: 424242,
                        extra: 0
                    }));
                    continue;
                }
                if (frame.kind !== "data") {
                    continue;
                }
                const plain = decryptFrame(frame, { localKey: LOCAL_KEY, connectNonce: session.connectNonce, ackNonce: session.ackNonce });
                const decoded = decodeRpcPayload(plain);
                requests.push(decoded.rpc);
                let result = ["ok"];
                let error;
                try {
                    if (typeof handler === "function") {
                        const produced = handler(decoded.rpc || {});
                        if (produced !== undefined) {
                            result = produced;
                        }
                    } else if (decoded.rpc && decoded.rpc.method === "get_status") {
                        result = [{ state: 8, battery: 87, error_code: 0, fan_power: 101 }];
                    }
                } catch (err) {
                    error = { message: err.message };
                    result = undefined;
                }
                const timestamp = 1700001111;
                socket.write(encodeDataFrame({
                    version: session.version,
                    seq: frame.seq,
                    random: 7,
                    timestamp,
                    protocol: PROTOCOL.PUBLISH,
                    payload: encodeRpcResponse({
                        id: decoded.rpc && decoded.rpc.id,
                        result,
                        error,
                        timestamp
                    }),
                    localKey: LOCAL_KEY,
                    connectNonce: session.connectNonce,
                    ackNonce: session.ackNonce
                }));
            }
        });
    });
    return new Promise((resolve, reject) => {
        server.listen(0, "127.0.0.1", () => {
            resolve({
                port: server.address().port,
                requests,
                helloVersions,
                close() {
                    for (const socket of sockets) {
                        socket.destroy();
                    }
                    return new Promise((done) => server.close(() => done()));
                }
            });
        });
        server.on("error", reject);
    });
}

module.exports = { startMock, LOCAL_KEY };
