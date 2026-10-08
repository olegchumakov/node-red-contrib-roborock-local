"use strict";

const { describe, test, after } = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { RoborockClient } = require("../lib/client");
const { FrameDecoder, encodeConnect, encodeControl, encodeDataFrame, decryptFrame } = require("../lib/frame");
const { decodeRpcPayload, encodeRpcResponse } = require("../lib/commands");
const { PROTOCOL } = require("../lib/constants");
const { resetForTests } = require("../lib/session");
const { protocolMemory, resetProtocolMemoryForTests } = require("../lib/protocol-cache");
const { startMock: startVersionMock } = require("./mock-vacuum");

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

    test("auto falls back to the other version and remembers the one that worked", async () => {
        const memory = protocolMemory(fs.mkdtempSync(path.join(os.tmpdir(), "rr-proto-")), "DUID-A");
        const l01 = await startVersionMock(undefined, { versions: ["L01"] });
        const first = new RoborockClient({
            host: "127.0.0.1",
            port: l01.port,
            localKey: LOCAL_KEY,
            knownProtocol: "1.0",
            protocolMemory: memory,
            pingIntervalMs: 0,
            helloTimeoutMs: 200,
            requestTimeoutMs: 1000
        });
        try {
            const status = await first.request("get_status", []);
            assert.equal(status[0].battery, 87);
            assert.equal(first.version, "L01");
            assert.equal(memory.get(), "L01");
            assert.deepEqual([...new Set(l01.helloVersions)], ["1.0", "L01"]);
        } finally {
            first.close();
            await l01.close();
        }

        const v10 = await startVersionMock(undefined, { versions: ["1.0"] });
        const second = new RoborockClient({
            host: "127.0.0.1",
            port: v10.port,
            localKey: LOCAL_KEY,
            knownProtocol: "1.0",
            protocolMemory: memory,
            pingIntervalMs: 0,
            helloTimeoutMs: 200,
            requestTimeoutMs: 1000
        });
        try {
            assert.deepEqual(second.versionsToTry(), ["L01", "1.0"], "the remembered version goes first");
            await second.request("get_status", []);
            assert.equal(second.version, "1.0", "a stale memory falls back instead of failing");
            assert.equal(memory.get(), "1.0");
        } finally {
            second.close();
            await v10.close();
        }
    });

    test("a cold auto connect that falls back to L01 keeps the link up on L01 only", async () => {
        const memory = protocolMemory(fs.mkdtempSync(path.join(os.tmpdir(), "rr-proto-")), "DUID-COLD");
        const mock = await startVersionMock(undefined, { versions: ["L01"], strict: true, idleCloseMs: 900 });
        const client = new RoborockClient({
            host: "127.0.0.1",
            port: mock.port,
            localKey: LOCAL_KEY,
            knownProtocol: "1.0",
            protocolMemory: memory,
            keepAliveSeconds: 1,
            pingIntervalMs: 1000,
            helloTimeoutMs: 150,
            requestTimeoutMs: 1000
        });
        let drops = 0;
        client.on("disconnect", () => {
            drops += 1;
        });
        try {
            assert.equal((await client.request("get_status", []))[0].battery, 87);
            assert.equal(client.version, "L01");
            assert.equal(mock.openSockets(), 1, "the sockets of the failed 1.0 hellos are gone");
            await new Promise((resolve) => setTimeout(resolve, 2600));
            assert.equal(drops, 0, `the robot closed the link: ${mock.closures.join(", ")}`);
            assert.deepEqual(mock.closures, []);
            assert.ok(mock.pings >= 3, `pings sent: ${mock.pings}`);
            assert.equal((await client.request("get_status", []))[0].battery, 87);
            assert.equal(mock.openSockets(), 1);
        } finally {
            client.close();
            await mock.close();
        }
    });

    test("the fake robot really closes a link that uses the wrong version or goes quiet", async () => {
        const mock = await startVersionMock(undefined, { versions: ["L01"], strict: true });
        const socket = net.connect({ host: "127.0.0.1", port: mock.port });
        await new Promise((resolve) => socket.once("connect", resolve));
        socket.write(encodeConnect({ version: "L01", connectNonce: 12345 }));
        await new Promise((resolve) => setTimeout(resolve, 50));
        socket.write(encodeControl({ version: "1.0", protocol: PROTOCOL.PING }));
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.deepEqual(mock.closures, ["wrong-version:1.0"]);
        socket.destroy();
        await mock.close();

        const quiet = await startVersionMock(undefined, { versions: ["L01"], idleCloseMs: 100 });
        const second = net.connect({ host: "127.0.0.1", port: quiet.port });
        await new Promise((resolve) => second.once("connect", resolve));
        second.write(encodeConnect({ version: "L01", connectNonce: 12345 }));
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.deepEqual(quiet.closures, ["idle"]);
        second.destroy();
        await quiet.close();
    });

    test("the ping interval never exceeds half the advertised keepalive", () => {
        const make = (extra) => new RoborockClient({ host: "127.0.0.1", localKey: LOCAL_KEY, ...extra });
        const intervals = [];
        const realSetInterval = global.setInterval;
        global.setInterval = (fn, ms) => {
            intervals.push(ms);
            return realSetInterval(() => {}, 1e9);
        };
        try {
            const a = make({});
            a.startPing();
            a.stopPing();
            const b = make({ pingIntervalMs: 2000 });
            b.startPing();
            b.stopPing();
        } finally {
            global.setInterval = realSetInterval;
        }
        assert.deepEqual(intervals, [5000, 2000]);
    });

    test("one shared client takes many nodes without a MaxListeners warning", () => {
        resetForTests();
        const warnings = [];
        const onWarning = (warning) => warnings.push(warning.name);
        process.on("warning", onWarning);
        try {
            const session = require("../lib/session").acquire("many-nodes", {
                host: "127.0.0.1",
                port: 1,
                localKey: LOCAL_KEY,
                pingIntervalMs: 0
            });
            for (let node = 0; node < 14; node += 1) {
                for (const event of ["status", "failure", "disconnect", "ready"]) {
                    session.client.on(event, () => {});
                }
            }
            assert.equal(session.client.listenerCount("status"), 14);
            return new Promise((resolve) => setImmediate(() => {
                process.removeListener("warning", onWarning);
                resetForTests();
                assert.deepEqual(warnings, []);
                resolve();
            }));
        } catch (err) {
            process.removeListener("warning", onWarning);
            resetForTests();
            throw err;
        }
    });

    test("the protocol memory survives a restart and holds no key", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-proto-"));
        protocolMemory(dir, "DUID-B").set("L01");
        resetProtocolMemoryForTests();
        assert.equal(protocolMemory(dir, "DUID-B").get(), "L01");
        assert.equal(protocolMemory(dir, "DUID-C").get(), null);
        protocolMemory(dir, "DUID-B").set("nonsense");
        assert.equal(protocolMemory(dir, "DUID-B").get(), "L01");
        assert.equal(fs.readFileSync(path.join(dir, "roborock-local-protocol-cache.json"), "utf8").includes(LOCAL_KEY), false);
    });
});
