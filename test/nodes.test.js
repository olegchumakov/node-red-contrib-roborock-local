"use strict";

const { describe, test, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const helper = require("node-red-node-test-helper");
const { startMock } = require("./mock-vacuum");
const { resetForTests } = require("../lib/session");
const { setDevicesLoaderForTests, setHomeLoaderForTests, clearEditorSessions } = require("../lib/admin");
const { rememberEditorSession, readEditorSession } = require("../lib/editor-sessions");
const deviceModule = require("../nodes/roborock-device.js");

let runtimeRED;
const register = (RED) => {
    runtimeRED = RED;
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
    beforeEach(() => {
        resetForTests();
        deviceModule.resetLegacySessionHintsForTests();
        setDevicesLoaderForTests(null);
        setHomeLoaderForTests(null);
        clearEditorSessions();
    });

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
            assert.deepEqual(response.body.maps[1].segments, []);
            assert.match(response.body.maps[1].note, /could not be read/i);
            assert.equal(response.body.maps[0].note, "rooms visible when this map is loaded");
            assert.match(response.body.mappingError, /mapping unavailable/);
            assert.equal(JSON.stringify(response.body).includes("lab_status"), false);
            assert.equal(JSON.stringify(response.body).includes("often means"), false);
            assert.equal(JSON.stringify(response.body).includes("testlocalkey1234"), false);
            assert.equal(mock.requests.some((rpc) => rpc.method === "load_multi_map"), false);
        } finally {
            await mock.close();
        }
    });

    test("the editor refuses to load a map", async () => {
        const mock = await startMock((rpc) => {
            if (rpc.method === "get_status") {
                return [{ state: 8, battery: 100, error_code: 0, map_status: 11 }];
            }
            if (rpc.method === "get_multi_maps_list") {
                return [{
                    map_info: [
                        { mapFlag: 1, name: "2 этаж" },
                        { mapFlag: 2, name: "1 этаж" }
                    ]
                }];
            }
            if (rpc.method === "get_room_mapping") {
                return [];
            }
            return ["ok"];
        });
        try {
            await helper.load(register, [
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
            ], {
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
                    protocol: "1.0",
                    action: "load",
                    mapFlag: "1"
                });
            assert.equal(response.status, 400);
            assert.match(response.body.error, /vacuum command/);
            assert.equal(mock.requests.some((rpc) => rpc.method === "load_multi_map"), false);
        } finally {
            await mock.close();
        }
    });

    test("a device with a leftover cloud session still runs without an account", async () => {
        const mock = await startMock();
        const secret = "leftover-session-token";
        try {
            await helper.load(register, [
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
                },
                { id: "n1", type: "roborock-vacuum", name: "vacuum", device: "dev1", pollInterval: 0, statusOnChange: true, wires: [["h1"], ["h2"]] },
                { id: "h1", type: "helper" },
                { id: "h2", type: "helper" }
            ], {
                dev1: {
                    ip: "127.0.0.1",
                    duid: "DUID1",
                    localKey: "testlocalkey1234",
                    model: "roborock.vacuum.a15",
                    email: "user@example.com",
                    userData: JSON.stringify({ token: secret })
                }
            });
            const device = helper.getNode("dev1");
            assert.equal(device.ip, "127.0.0.1");
            assert.equal(device.localKey, "testlocalkey1234");
            assert.equal(device.account, undefined);
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
            const logged = helper.log().getCalls().map((call) => JSON.stringify(call.args)).join("\n");
            assert.match(logged, /roborock account/);
            assert.equal(logged.includes(secret), false);
            assert.equal(logged.includes("user@example.com"), false);
        } finally {
            await mock.close();
        }
    });

    test("fetch devices uses the editor session cache before the account is deployed", async () => {
        await helper.load(register, []);
        const secret = "editor-cache-token";
        rememberEditorSession("account-unsaved", {
            email: "user@example.com",
            userData: { token: secret, rriot: { u: "u" } }
        });
        setDevicesLoaderForTests(async (source) => {
            assert.equal(source.userData.token, secret);
            return {
                rooms: [],
                devices: [{ duid: "D1", name: "S7", model: "roborock.vacuum.a15", localKey: "device-key", pv: "1.0" }]
            };
        });
        const response = await helper.request()
            .post("/roborock-local/devices")
            .send({ nodeId: "account-unsaved", discover: false });
        assert.equal(response.status, 200);
        assert.equal(response.body.ok, true);
        assert.equal(response.body.devices[0].duid, "D1");
        assert.equal(JSON.stringify(response.body).includes(secret), false);
    });

    test("pending account credentials are used and a placeholder is not", async () => {
        await helper.load(register, []);
        rememberEditorSession("account-unsaved", {
            userData: { token: "cached-token" }
        });
        setDevicesLoaderForTests(async (source) => {
            return {
                rooms: [],
                devices: [{ duid: source.userData.token === "pending-token" ? "PENDING" : "CACHED", name: "S7", localKey: "k" }]
            };
        });
        const pending = await helper.request()
            .post("/roborock-local/devices")
            .send({ nodeId: "account-unsaved", userData: { token: "pending-token" }, discover: false });
        assert.equal(pending.status, 200);
        assert.equal(pending.body.devices[0].duid, "PENDING");
        assert.equal(JSON.stringify(pending.body).includes("pending-token"), false);
        const placeholder = await helper.request()
            .post("/roborock-local/devices")
            .send({ nodeId: "account-unsaved", userData: "__PWRD__", discover: false });
        assert.equal(placeholder.status, 200);
        assert.equal(placeholder.body.devices[0].duid, "CACHED");
        assert.equal(JSON.stringify(placeholder.body).includes("cached-token"), false);
    });

    test("fetch devices without a session tells you to sign in on the account", async () => {
        await helper.load(register, []);
        const response = await helper.request()
            .post("/roborock-local/devices")
            .send({ nodeId: "not-deployed", token: "super-secret-token" });
        assert.equal(response.status, 401);
        assert.match(response.body.error, /roborock account/);
        assert.match(response.body.error, /Deploy is not required/);
        assert.equal(JSON.stringify(response.body).includes("super-secret-token"), false);
    });

    test("deploy clears the editor session cache", async () => {
        await helper.load(register, []);
        rememberEditorSession("account-unsaved", { userData: { token: "cached-token" } });
        assert.ok(readEditorSession("account-unsaved"));
        runtimeRED.events.emit("flows:started", {});
        assert.equal(readEditorSession("account-unsaved"), null);
    });

    test("the device editor has no login form and does not store or load maps", () => {
        const deviceHtml = fs.readFileSync(path.join(__dirname, "../nodes/roborock-device.html"), "utf8");
        const vacuumHtml = fs.readFileSync(path.join(__dirname, "../nodes/roborock-vacuum.html"), "utf8");
        const accountHtml = fs.readFileSync(path.join(__dirname, "../nodes/roborock-account.html"), "utf8");
        assert.equal(deviceHtml.includes("rr-manual-segments"), false);
        assert.equal(deviceHtml.includes("rr-send-code"), false);
        assert.equal(deviceHtml.includes("RED.notify"), false);
        assert.equal(deviceHtml.includes("node-config-input-rooms"), false);
        assert.equal(deviceHtml.includes(">Load<"), false);
        assert.equal(deviceHtml.includes("action: \"load\""), false);
        assert.equal(deviceHtml.includes("readMaps"), false);
        assert.match(deviceHtml, /Show maps &amp; rooms/);
        assert.match(deviceHtml, /rooms visible when this map is loaded/);
        assert.match(deviceHtml, /\{"command":"map_rooms"\}/);
        assert.match(vacuumHtml, /\{"command":"map","mapFlag":1\}/);
        assert.match(vacuumHtml, /\{"command":"rooms","segments":\[16,17\],"repeat":1\}/);
        const creds = deviceHtml.slice(deviceHtml.lastIndexOf("credentials:"), deviceHtml.indexOf("label:"));
        assert.equal(creds.includes("userData"), false);
        assert.equal(creds.includes("email"), false);
        assert.match(accountHtml, /nodeId: node.id/);
        assert.match(accountHtml, /Import Home Assistant session/);
        assert.match(accountHtml, /rr-account-pass-login/);
    });

    test("stale map fields on a device config do not stop the vacuum", async () => {
        const mock = await startMock();
        try {
            await helper.load(register, [
                {
                    id: "dev1",
                    type: "roborock-device",
                    name: "S7",
                    protocol: "1.0",
                    pv: "1.0",
                    rooms: "[{\"segmentId\":16,\"name\":\"Kitchen\"}]",
                    maps: [{ mapFlag: 1, name: "2 этаж" }],
                    mapFlag: 1,
                    port: mock.port,
                    pingIntervalMs: 0,
                    helloTimeoutMs: 1000,
                    requestTimeoutMs: 1000
                },
                { id: "n1", type: "roborock-vacuum", name: "vacuum", device: "dev1", pollInterval: 0, statusOnChange: true, wires: [["h1"], ["h2"]] },
                { id: "h1", type: "helper" },
                { id: "h2", type: "helper" }
            ], {
                dev1: {
                    ip: "127.0.0.1",
                    duid: "DUID1",
                    localKey: "testlocalkey1234",
                    model: "roborock.vacuum.a15"
                }
            });
            const device = helper.getNode("dev1");
            assert.equal(device.rooms, undefined);
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
        } finally {
            await mock.close();
        }
    });

    test("map_rooms lists every floor and names only linked rooms; map load and room clean stay commands", async () => {
        const mock = await startMock((rpc) => {
            if (rpc.method === "get_status") {
                return [{ state: 8, battery: 90, error_code: 0, map_status: 7 }];
            }
            if (rpc.method === "get_multi_maps_list") {
                return [{
                    map_info: [
                        { mapFlag: 1, name: "2 этаж" },
                        {
                            mapFlag: 2,
                            name: "1 этаж",
                            rooms: [
                                { id: 16, iot_name_id: "1", iot_name: "Спальня" },
                                { id: 17, iot_name_id: "2", iot_name: "Кухня" },
                                { id: 18, iot_name: "Коридор" },
                                { id: 19 }
                            ]
                        }
                    ]
                }];
            }
            if (rpc.method === "get_room_mapping") {
                return [[20, "99", 12]];
            }
            return ["ok"];
        });
        try {
            setHomeLoaderForTests(async (accountId) => {
                assert.equal(accountId, "acc1");
                return {
                    rooms: [
                        { id: 1, name: "Главная спальня" },
                        { id: 2, name: "Гостиная" },
                        { id: 99, name: "Kitchen" }
                    ]
                };
            });
            await helper.load(register, [
                { id: "acc1", type: "roborock-account", name: "account" },
                {
                    id: "dev1",
                    type: "roborock-device",
                    name: "S7",
                    account: "acc1",
                    protocol: "1.0",
                    pv: "1.0",
                    rooms: "[{\"segmentId\":3,\"name\":\"Kitchen\"}]",
                    port: mock.port,
                    pingIntervalMs: 0,
                    helloTimeoutMs: 1000,
                    requestTimeoutMs: 1000
                },
                { id: "n1", type: "roborock-vacuum", name: "vacuum", device: "dev1", pollInterval: 0, statusOnChange: true, wires: [["h1"], ["h2"]] },
                { id: "h1", type: "helper" },
                { id: "h2", type: "helper" }
            ], {
                dev1: {
                    ip: "127.0.0.1",
                    duid: "DUID1",
                    localKey: "testlocalkey1234",
                    model: "roborock.vacuum.a15"
                }
            });
            const n1 = helper.getNode("n1");
            const h1 = helper.getNode("h1");
            const listed = await once(h1, () => n1.receive({ payload: { command: "map_rooms" } }));
            assert.equal(listed.command, "map_rooms");
            assert.equal(listed.payload.currentMapFlag, 1);
            assert.equal(listed.payload.maps[0].name, "2 этаж");
            assert.equal(listed.payload.maps[0].current, true);
            assert.deepEqual(listed.payload.maps[0].segments, [{ segmentId: 20, name: "Kitchen" }]);
            assert.equal(listed.payload.maps[1].note, undefined);
            assert.deepEqual(listed.payload.maps[1].segments.map((segment) => segment.segmentId), [16, 17, 18, 19]);
            assert.equal(listed.payload.maps[1].segments[0].name, "Спальня");
            assert.equal(JSON.stringify(listed.payload).includes("Главная спальня"), false);
            assert.equal(JSON.stringify(listed.payload).includes("Гостиная"), false);
            assert.equal(mock.requests.some((rpc) => rpc.method === "load_multi_map"), false);

            const cleaned = await once(h1, () => n1.receive({ payload: { command: "rooms", names: ["Kitchen"] } }));
            assert.equal(cleaned.method, "app_segment_clean");
            assert.deepEqual(cleaned.payload, ["ok"]);
            const cleanCall = mock.requests.filter((rpc) => rpc.method === "app_segment_clean").pop();
            assert.deepEqual(cleanCall.params, [{ segments: [20], repeat: 1 }]);

            const byId = await once(h1, () => n1.receive({ payload: { command: "rooms", segments: [16, 17], repeat: 2 } }));
            assert.equal(byId.method, "app_segment_clean");
            const idCall = mock.requests.filter((rpc) => rpc.method === "app_segment_clean").pop();
            assert.deepEqual(idCall.params, [{ segments: [16, 17], repeat: 2 }]);

            const switched = await once(h1, () => n1.receive({ payload: { command: "map", mapFlag: "2" } }));
            assert.equal(switched.method, "load_multi_map");
            const loadCall = mock.requests.filter((rpc) => rpc.method === "load_multi_map").pop();
            assert.deepEqual(loadCall.params, [2]);
            assert.equal(typeof loadCall.params[0], "number");

            const shown = await helper.request()
                .post("/roborock-local/map-rooms")
                .send({ nodeId: "dev1", accountId: "acc1", protocol: "1.0", pv: "1.0" });
            assert.equal(shown.status, 200);
            assert.equal(shown.body.ok, true);
            assert.equal(shown.body.maps[1].segments.length, 4);
            assert.equal(JSON.stringify(shown.body).includes("Главная спальня"), false);
            assert.equal(mock.requests.filter((rpc) => rpc.method === "load_multi_map").length, 1);
        } finally {
            await mock.close();
        }
    });

function once(node, fire) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no message")), 8000);
        node.removeAllListeners("input");
        node.on("input", (msg) => {
            clearTimeout(timer);
            resolve(msg);
        });
        fire();
    });
}

    test("admin send-code rejects a missing email", async () => {
        await helper.load(register, []);
        const response = await helper.request()
            .post("/roborock-local/send-code")
            .send({});
        assert.equal(response.status, 400);
        assert.match(response.body.error, /email/i);
    });
});
