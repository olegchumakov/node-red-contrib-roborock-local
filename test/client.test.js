"use strict";

const { describe, test, after } = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const { RoborockClient } = require("../lib/client");
const { FrameDecoder, encodeControl, encodeDataFrame, decryptFrame } = require("../lib/frame");
const { decodeRpcPayload, encodeRpcResponse } = require("../lib/commands");
const { PROTOCOL } = require("../lib/constants");
const { resetForTests } = require("../lib/session");

const LOCAL_KEY = "testlocalkey1234";

function startMock(handler) {
    const requests = [];
    const sockets = new Set();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        const decoder = new FrameDecoder();
        socket.on("data", (chunk) => {
            const frames = decoder.push(chunk);
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
                if (frame.kind === "control" && frame.protocol === PROTOCOL.PING) {
                    socket.write(encodeControl({ version: frame.version, protocol: PROTOCOL.PONG }));
                    continue;
                }
                if (frame.kind !== "data") {
                    continue;
                }
                const plain = decryptFrame(frame, { localKey: LOCAL_KEY });
                const decoded = decodeRpcPayload(plain);
                requests.push(decoded.rpc);
                const result = handler(decoded.rpc);
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

describe("local client", () => {
    after(() => resetForTests());

    test("handshake, get_status, and shorthand start", async () => {
        const mock = await startMock((rpc) => {
            if (rpc.method === "get_status") {
                return [{ state: 8, battery: 87, error_code: 0, fan_power: 102, clean_area: 0 }];
            }
            if (rpc.method === "app_start") {
                return ["ok"];
            }
            if (rpc.method === "set_custom_mode") {
                return ["ok"];
            }
            return ["ok"];
        });
        const client = new RoborockClient({
            host: "127.0.0.1",
            port: mock.port,
            localKey: LOCAL_KEY,
            duid: "DUID1",
            pingIntervalMs: 0,
            helloTimeoutMs: 1000,
            requestTimeoutMs: 1000
        });
        try {
            const status = await client.request("get_status", []);
            assert.equal(status[0].battery, 87);
            assert.equal(client.lastStatus.stateName, "charging");
            assert.equal(client.version, "1.0");
            assert.equal(client.helloStyle, "app");
            const started = await client.request("app_start", []);
            assert.deepEqual(started, ["ok"]);
            const methods = mock.requests.map((rpc) => rpc.method);
            assert.ok(methods.includes("get_status"));
            assert.ok(methods.includes("app_start"));
            const fan = await client.request("set_custom_mode", 103);
            assert.deepEqual(fan, ["ok"]);
            const fanCall = mock.requests.find((rpc) => rpc.method === "set_custom_mode");
            assert.equal(fanCall.params, 103);
        } finally {
            client.close();
            await mock.close();
        }
    });

    test("times out when the device never answers the RPC", async () => {
        const server = net.createServer((socket) => {
            const decoder = new FrameDecoder();
            socket.on("data", (chunk) => {
                const frames = decoder.push(chunk);
                for (const frame of frames) {
                    if (frame.protocol === PROTOCOL.CONNECT) {
                        socket.write(encodeControl({
                            version: frame.version,
                            protocol: PROTOCOL.CONNACK,
                            random: 1,
                            extra: 0
                        }));
                    }
                }
            });
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const client = new RoborockClient({
            host: "127.0.0.1",
            port: server.address().port,
            localKey: LOCAL_KEY,
            pingIntervalMs: 0,
            helloTimeoutMs: 500,
            requestTimeoutMs: 200
        });
        try {
            await assert.rejects(client.request("get_status", []), /No response to get_status/);
        } finally {
            client.close();
            await new Promise((resolve) => server.close(resolve));
        }
    });
});
