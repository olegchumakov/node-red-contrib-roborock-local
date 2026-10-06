"use strict";

const net = require("net");
const { FrameDecoder, encodeControl, encodeDataFrame, decryptFrame } = require("../lib/frame");
const { decodeRpcPayload, encodeRpcResponse } = require("../lib/commands");
const { PROTOCOL } = require("../lib/constants");

const LOCAL_KEY = "testlocalkey1234";

function startMock() {
    const requests = [];
    const sockets = new Set();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        const decoder = new FrameDecoder();
        socket.on("data", (chunk) => {
            let frames = [];
            try {
                frames = decoder.push(chunk);
            } catch (_err) {
                return;
            }
            for (const frame of frames) {
                if (frame.kind === "control" && frame.protocol === PROTOCOL.CONNECT) {
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
                const plain = decryptFrame(frame, { localKey: LOCAL_KEY });
                const decoded = decodeRpcPayload(plain);
                requests.push(decoded.rpc);
                let result = ["ok"];
                if (decoded.rpc && decoded.rpc.method === "get_status") {
                    result = [{ state: 8, battery: 87, error_code: 0, fan_power: 101 }];
                }
                const timestamp = 1700001111;
                socket.write(encodeDataFrame({
                    version: "1.0",
                    seq: frame.seq,
                    random: 7,
                    timestamp,
                    protocol: PROTOCOL.PUBLISH,
                    payload: encodeRpcResponse({ id: decoded.rpc.id, result, timestamp }),
                    localKey: LOCAL_KEY
                }));
            }
        });
    });
    return new Promise((resolve, reject) => {
        server.listen(0, "127.0.0.1", () => {
            resolve({
                port: server.address().port,
                requests,
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
