"use strict";

const { describe, test, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const helper = require("node-red-node-test-helper");
const { startMock } = require("./mock-vacuum");
const { resetForTests } = require("../lib/session");

const register = (RED) => {
    require("../nodes/roborock-account.js")(RED);
    require("../nodes/roborock-device.js")(RED);
    require("../nodes/roborock-vacuum.js")(RED);
};

helper.init(require.resolve("node-red"), {
    userDir: path.join(os.tmpdir(), `roborock-nr-${process.pid}`),
    uiPort: 18881,
    logging: { console: { level: "off" } }
});

describe("node-red nodes", () => {
    before(async () => {
        await helper.startServer();
    });
    after(async () => {
        resetForTests();
        await helper.stopServer();
    });
    afterEach(async () => {
        resetForTests();
        await helper.unload();
    });
    beforeEach(() => resetForTests());

    test("vacuum node commands a mocked device and keeps the key out of the example flow", async () => {
        const example = fs.readFileSync(path.join(__dirname, "../examples/roborock-local.json"), "utf8");
        assert.equal(example.includes('"localKey"'), false);
        assert.equal(example.includes('"local_key"'), false);
        assert.equal(example.includes("testlocalkey"), false);

        const mock = await startMock();
        const flow = [
            { id: "dev1", type: "roborock-device", name: "S7", protocol: "auto", deviceName: "Downstairs", rooms: "[]", port: mock.port, pingIntervalMs: 0, helloTimeoutMs: 1000, requestTimeoutMs: 1000 },
            { id: "n1", type: "roborock-vacuum", name: "vacuum", device: "dev1", pollInterval: 0, statusOnChange: true, wires: [["h1"], ["h2"]] },
            { id: "h1", type: "helper" },
            { id: "h2", type: "helper" }
        ];
        const credentials = {
            dev1: {
                ip: "127.0.0.1",
                duid: "DUID1",
                localKey: "testlocalkey1234",
                model: "roborock.vacuum.a15"
            }
        };
        await helper.load(register, flow, credentials);
        const n1 = helper.getNode("n1");
        const h1 = helper.getNode("h1");
        const result = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("no command result")), 8000);
            h1.on("input", (msg) => {
                clearTimeout(timer);
                resolve(msg);
            });
        });
        n1.receive({ payload: "status" });
        const msg = await result;
        assert.equal(msg.method, "get_status");
        assert.equal(msg.payload[0].battery, 87);
        assert.equal(msg.status.stateName, "charging");
        assert.equal(msg.device.model, "roborock.vacuum.a15");
        assert.equal(JSON.stringify(flow).includes("testlocalkey1234"), false);

        const started = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("no start result")), 8000);
            h1.removeAllListeners("input");
            h1.on("input", (msg2) => {
                clearTimeout(timer);
                resolve(msg2);
            });
        });
        n1.receive({ payload: { command: "fan", speed: "silent" } });
        const fan = await started;
        assert.equal(fan.method, "set_custom_mode");
        assert.deepEqual(fan.payload, ["ok"]);
        await mock.close();
    });

    test("admin import-session rejects a token without rriot and does not echo it", async () => {
        await helper.load(register, []);
        const response = await helper.request()
            .post("/roborock-local/import-session")
            .send({ userData: { token: "super-secret-token" } });
        assert.equal(response.status, 400);
        assert.equal(JSON.stringify(response.body).includes("super-secret-token"), false);
        assert.match(response.body.error, /rriot/i);
    });

    test("read maps still returns the map list when get_room_mapping fails", async () => {
        const mock = await startMock((rpc) => {
            if (rpc.method === "get_status") {
                return [{
                    state: 8,
                    battery: 100,
                    error_code: 0,
                    map_status: 11,
                    lab_status: 3,
                    unsave_map_flag: 2
                }];
            }
            if (rpc.method === "get_multi_maps_list") {
                return [{
                    max_multi_map: 4,
                    max_bak_map: 1,
                    multi_map_count: 2,
                    map_info: [
                        { mapFlag: 1, add_time: 1693646551, length: 10, name: "2 этаж", bak_maps: [{ mapFlag: 5, add_time: 1682500367 }] },
                        { mapFlag: 2, add_time: 1791144593, length: 10, name: "1 этаж", bak_maps: [{ mapFlag: 6, add_time: 1789666028 }] }
                    ]
                }];
            }
            if (rpc.method === "get_room_mapping") {
                throw new Error("mapping unavailable");
            }
            return ["ok"];
        });
        try {
            const flow = [
                {
                    id: "dev1",
                    type: "roborock-device",
                    name: "S7",
                    protocol: "1.0",
                    pv: "1.0",
                    rooms: "[]",
                    port: mock.port,
                    pingIntervalMs: 0,
                    helloTimeoutMs: 1000,
                    requestTimeoutMs: 1000
                }
            ];
            await helper.load(register, flow, {
                dev1: {
                    ip: "127.0.0.1",
                    duid: "DUID1",
                    localKey: "testlocalkey1234",
                    model: "roborock.vacuum.a15"
                }
            });
            const response = await helper.request()
                .post("/roborock-local/map-rooms")
                .send({
                    nodeId: "dev1",
                    ip: "127.0.0.1",
                    localKey: "testlocalkey1234",
                    pv: "1.0",
                    protocol: "1.0"
                });
            assert.equal(response.status, 200);
            assert.equal(response.body.ok, true);
            assert.equal(response.body.maps[0].name, "2 этаж");
            assert.equal(response.body.maps[1].name, "1 этаж");
            assert.equal(response.body.currentMapFlag, 2);
            assert.equal(response.body.maps[1].current, true);
            assert.deepEqual(response.body.segments, []);
            assert.match(response.body.mappingError, /mapping unavailable/);
            assert.match(response.body.warning, /Could not read segments/);
            assert.match(response.body.warning, /1 этаж/);
            assert.match(response.body.warning, /not used/);
            assert.equal(response.body.warning.includes("lab_status"), false);
            assert.equal(response.body.warning.includes("often means"), false);
            assert.equal(JSON.stringify(response.body).includes("testlocalkey1234"), false);
        } finally {
            await mock.close();
        }
    });

    test("admin send-code rejects a missing email", async () => {
        await helper.load(register, []);
        const response = await helper.request()
            .post("/roborock-local/send-code")
            .send({});
        assert.equal(response.status, 400);
        assert.match(response.body.error, /email/i);
    });
});
