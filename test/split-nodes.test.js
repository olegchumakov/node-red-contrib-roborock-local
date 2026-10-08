"use strict";

const { describe, test, before, after, afterEach, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const helper = require("node-red-node-test-helper");

const { startMock } = require("./mock-vacuum");
const { resetForTests } = require("../lib/session");
const { setHomeLoaderForTests } = require("../lib/admin");
const { resetMapCacheForTests } = require("../lib/map-cache");
const { setFailureStatusMsForTests } = require("../lib/node-helpers");
const { resetProtocolMemoryForTests, cacheFilePath: protocolCacheFile } = require("../lib/protocol-cache");
const { setDockRetryMsForTests } = require("../nodes/roborock-command.js");
const sessionPool = require("../lib/session");

const NODE_FILES = ["account", "device", "vacuum", "command", "status", "clean-rooms", "settings", "maps", "consumables"];
const register = (RED) => {
    for (const name of NODE_FILES) {
        require(`../nodes/roborock-${name}.js`)(RED);
    }
};

helper.init(require.resolve("node-red"), {
    userDir: path.join(os.tmpdir(), `roborock-split-${process.pid}`),
    uiPort: 18882,
    logging: { console: { level: "off" } }
});

const CREDENTIALS = {
    dev1: { ip: "127.0.0.1", duid: "DUID1", localKey: "testlocalkey1234", model: "roborock.vacuum.a15" }
};

function deviceNode(mock) {
    return { id: "dev1", type: "roborock-device", name: "S7", protocol: "auto", port: mock.port, pingIntervalMs: 0, helloTimeoutMs: 1000, requestTimeoutMs: 1000 };
}

function collect(id) {
    const node = helper.getNode(id);
    const messages = [];
    const waiters = [];
    node.on("input", (msg) => {
        messages.push(msg);
        const waiter = waiters.shift();
        if (waiter) {
            waiter(msg);
        }
    });
    return {
        messages,
        next(ms = 5000) {
            if (messages.length) {
                return Promise.resolve(messages.shift());
            }
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`no message on ${id}`)), ms);
                waiters.push((msg) => {
                    clearTimeout(timer);
                    messages.splice(messages.indexOf(msg), 1);
                    resolve(msg);
                });
            });
        }
    };
}

function methods(mock) {
    return mock.requests.map((rpc) => rpc.method);
}

describe("split nodes", () => {
    before(async () => {
        await helper.startServer();
    });
    after(async () => {
        resetForTests();
        await helper.stopServer();
    });
    beforeEach(() => {
        resetForTests();
        setHomeLoaderForTests(null);
        resetMapCacheForTests();
        resetProtocolMemoryForTests();
        fs.rmSync(protocolCacheFile(path.join(os.tmpdir(), `roborock-split-${process.pid}`)), { force: true });
    });
    afterEach(async () => {
        resetForTests();
        await helper.unload();
    });

    test("command sends the chosen action, accepts an override, and keeps the incoming message", async () => {
        const mock = await startMock();
        try {
            await helper.load(register, [
                deviceNode(mock),
                { id: "n1", type: "roborock-command", device: "dev1", action: "start", wires: [["out"]] },
                { id: "n2", type: "roborock-command", device: "dev1", action: "pause", wires: [["err"]] },
                { id: "c1", type: "catch", scope: ["n2"], uncaught: false, wires: [["err"]] },
                { id: "out", type: "helper" },
                { id: "err", type: "helper" }
            ], CREDENTIALS);
            const out = collect("out");
            const err = collect("err");
            helper.getNode("n1").receive({ topic: "kept", keep: 1 });
            const first = await out.next();
            assert.equal(first.method, "app_start");
            assert.equal(first.topic, "kept");
            assert.equal(first.keep, 1);
            assert.equal(first.device.duid, "DUID1");

            helper.getNode("n1").receive({ payload: "dock" });
            assert.equal((await out.next()).method, "app_charge");

            helper.getNode("n2").receive({ payload: "strat" });
            const failure = await err.next();
            assert.match(failure.error.message, /Unknown action "strat"/);
            assert.equal(methods(mock).includes("strat"), false);
        } finally {
            await mock.close();
        }
    });

    test("status reads on demand, sends events, and fires low-battery once", async () => {
        let state = { state: 8, battery: 80, error_code: 0 };
        const mock = await startMock((rpc) => {
            if (rpc.method === "get_status") {
                return [state];
            }
            return ["ok"];
        });
        try {
            await helper.load(register, [
                deviceNode(mock),
                { id: "n1", type: "roborock-status", device: "dev1", pollInterval: 0, statusOnChange: true, lowBattery: 20, wires: [["status"], ["events"]] },
                { id: "status", type: "helper" },
                { id: "events", type: "helper" }
            ], CREDENTIALS);
            const status = collect("status");
            const events = collect("events");
            const n1 = helper.getNode("n1");

            n1.receive({ topic: "ask" });
            const first = await status.next();
            assert.equal(first.payload.stateName, "charging");
            assert.equal(first.payload.battery, 80);
            assert.equal(first.kind, "status");
            assert.equal(first.topic, "ask", "the incoming topic passes through");
            assert.equal(events.messages.length, 0);

            n1.receive({});
            assert.equal((await status.next()).payload.battery, 80, "an on-demand read is sent even when nothing changed");

            state = { state: 5, battery: 60, error_code: 0 };
            n1.receive({});
            const started = await events.next();
            assert.equal(started.payload, "cleaning-started");
            assert.equal(started.status.stateName, "cleaning");
            await status.next();

            state = { state: 5, battery: 19, error_code: 0 };
            n1.receive({});
            assert.equal((await events.next()).payload, "low-battery");
            await status.next();

            state = { state: 5, battery: 18, error_code: 0 };
            n1.receive({});
            await status.next();
            assert.equal(events.messages.length, 0, "low-battery is not repeated");

            state = { state: 12, battery: 18, error_code: 5 };
            n1.receive({});
            assert.equal((await events.next()).payload, "error");
            await status.next();

            state = { state: 8, battery: 18, error_code: 0 };
            n1.receive({});
            assert.equal((await events.next()).payload, "error-cleared");
        } finally {
            await mock.close();
        }
    });

    test("settings sends the fan and mop as one-element lists and refuses an empty request", async () => {
        const mock = await startMock();
        try {
            await helper.load(register, [
                deviceNode(mock),
                { id: "n1", type: "roborock-settings", device: "dev1", fan: "turbo", mop: "", wires: [["out"]] },
                { id: "n2", type: "roborock-settings", device: "dev1", fan: "", mop: "", wires: [["out"]] },
                { id: "c1", type: "catch", scope: ["n2"], uncaught: false, wires: [["err"]] },
                { id: "out", type: "helper" },
                { id: "err", type: "helper" }
            ], CREDENTIALS);
            const out = collect("out");
            const err = collect("err");
            helper.getNode("n1").receive({ payload: { mop: "high" } });
            const result = await out.next();
            assert.deepEqual(result.applied, { fan: 103, mop: 203 });
            const fan = mock.requests.find((rpc) => rpc.method === "set_custom_mode");
            const mop = mock.requests.find((rpc) => rpc.method === "set_water_box_custom_mode");
            assert.deepEqual(fan.params, [103]);
            assert.deepEqual(mop.params, [203]);

            helper.getNode("n2").receive({ payload: "x" });
            assert.match((await err.next()).error.message, /Nothing to set/);

            helper.getNode("n1").receive({ fan: "warp" });
            assert.equal(methods(mock).filter((method) => method === "set_custom_mode").length, 1);
        } finally {
            await mock.close();
        }
    });

    test("consumables reports percent left and alerts on worn parts only", async () => {
        const mock = await startMock((rpc) => {
            if (rpc.method === "get_consumable") {
                return [{ main_brush_work_time: 270 * 3600, side_brush_work_time: 20 * 3600, filter_work_time: 100 * 3600, sensor_dirty_time: 1 * 3600 }];
            }
            return ["ok"];
        });
        try {
            await helper.load(register, [
                deviceNode(mock),
                { id: "n1", type: "roborock-consumables", device: "dev1", threshold: 15, wires: [["all"], ["low"]] },
                { id: "n2", type: "roborock-consumables", device: "dev1", threshold: 0, wires: [["all"], ["low"]] },
                { id: "all", type: "helper" },
                { id: "low", type: "helper" }
            ], CREDENTIALS);
            const all = collect("all");
            const low = collect("low");
            helper.getNode("n1").receive({ topic: "daily" });
            const result = await all.next();
            assert.equal(result.kind, "consumables");
            assert.equal(result.topic, "daily", "the incoming topic passes through");
            assert.equal(result.payload.parts.mainBrush.remainingPercent, 10);
            assert.equal(result.payload.parts.mainBrush.remainingHours, 30);
            assert.equal(result.payload.parts.filter.remainingPercent, 33);
            assert.deepEqual(result.low, ["mainBrush"]);
            const alert = await low.next();
            assert.deepEqual(alert.payload, ["mainBrush"]);
            assert.equal(alert.kind, "consumables-low");
            assert.equal(alert.topic, "daily");

            helper.getNode("n2").receive({});
            await all.next();
            assert.equal(low.messages.length, 0);
        } finally {
            await mock.close();
        }
    });

    function twoFloorMock(state) {
        const rooms = { 1: [[20, "99", 12]], 2: [[16, "77"], [17, "78"]] };
        return startMock((rpc) => {
            if (rpc.method === "get_status") {
                return [{ state: state.state, battery: 90, error_code: 0, map_status: state.loaded === 2 ? 11 : 7 }];
            }
            if (rpc.method === "get_multi_maps_list") {
                return [{ map_info: [{ mapFlag: 1, name: "2 этаж" }, { mapFlag: 2, name: "1 этаж" }] }];
            }
            if (rpc.method === "get_room_mapping") {
                return rooms[state.loaded] || [];
            }
            if (rpc.method === "load_multi_map") {
                state.loaded = Number(rpc.params[0]);
                return ["ok"];
            }
            return ["ok"];
        });
    }

    test("maps reads without switching and loads a floor only when asked", async () => {
        const state = { loaded: 1, state: 8 };
        const mock = await twoFloorMock(state);
        try {
            await helper.load(register, [
                deviceNode(mock),
                { id: "n1", type: "roborock-maps", device: "dev1", action: "read", mapFlag: "", wires: [["out"]] },
                { id: "n2", type: "roborock-maps", device: "dev1", action: "load", mapFlag: "2", wires: [["out"]] },
                { id: "out", type: "helper" }
            ], CREDENTIALS);
            const out = collect("out");
            helper.getNode("n1").receive({ topic: "t" });
            const read = await out.next();
            assert.equal(read.topic, "t");
            assert.equal(read.payload.currentMapFlag, 1);
            assert.equal(read.payload.maps.length, 2);
            assert.equal(methods(mock).includes("load_multi_map"), false);

            helper.getNode("n2").receive({});
            const loaded = await out.next();
            assert.equal(loaded.payload.currentMapFlag, 2);
            assert.equal(loaded.payload.previousMapFlag, 1);
            assert.deepEqual(loaded.payload.maps.find((map) => map.mapFlag === 2).segments.map((segment) => segment.segmentId), [16, 17]);
            assert.equal(state.loaded, 2);
        } finally {
            await mock.close();
        }
    });

    test("maps refuses to load a floor while the robot is cleaning", async () => {
        const state = { loaded: 1, state: 5 };
        const mock = await twoFloorMock(state);
        try {
            await helper.load(register, [
                deviceNode(mock),
                { id: "n1", type: "roborock-maps", device: "dev1", action: "load", mapFlag: "2", wires: [[]] },
                { id: "c1", type: "catch", scope: ["n1"], uncaught: false, wires: [["err"]] },
                { id: "err", type: "helper" }
            ], CREDENTIALS);
            const err = collect("err");
            helper.getNode("n1").receive({});
            assert.match((await err.next()).error.message, /cleaning/);
            assert.equal(methods(mock).includes("load_multi_map"), false);
        } finally {
            await mock.close();
        }
    });

    test("clean-rooms cleans configured segments with fan, mop and repeat, and lets the message override them", async () => {
        const state = { loaded: 1, state: 8 };
        const mock = await twoFloorMock(state);
        try {
            await helper.load(register, [
                deviceNode(mock),
                { id: "n1", type: "roborock-clean-rooms", device: "dev1", segments: "20", names: "", mapFlag: "", repeat: "2", fan: "turbo", mop: "low", wires: [["out"]] },
                { id: "out", type: "helper" }
            ], CREDENTIALS);
            const out = collect("out");
            helper.getNode("n1").receive({ topic: "evening" });
            const first = await out.next();
            assert.equal(first.topic, "evening");
            assert.deepEqual(first.segments, [20]);
            assert.equal(first.floorSwitched, false);
            const clean = mock.requests.find((rpc) => rpc.method === "app_segment_clean");
            assert.deepEqual(clean.params, [{ segments: [20], repeat: 2 }]);
            assert.deepEqual(mock.requests.find((rpc) => rpc.method === "set_custom_mode").params, [103]);
            assert.deepEqual(mock.requests.find((rpc) => rpc.method === "set_water_box_custom_mode").params, [201]);
            assert.equal(methods(mock).includes("load_multi_map"), false);

            helper.getNode("n1").receive({ payload: [21, 22], repeat: 1 });
            const second = await out.next();
            assert.deepEqual(second.segments, [21, 22]);
            const last = mock.requests.filter((rpc) => rpc.method === "app_segment_clean").pop();
            assert.deepEqual(last.params, [{ segments: [21, 22], repeat: 1 }]);
        } finally {
            await mock.close();
        }
    });

    test("clean-rooms switches to the chosen floor first and resolves a name on that floor", async () => {
        const state = { loaded: 1, state: 8 };
        const mock = await twoFloorMock(state);
        try {
            setHomeLoaderForTests(async () => ({ rooms: [{ id: 77, name: "Hall" }, { id: 78, name: "Bath" }, { id: 99, name: "Kitchen" }] }));
            await helper.load(register, [
                { id: "acc1", type: "roborock-account", name: "account" },
                { ...deviceNode(mock), account: "acc1" },
                { id: "n1", type: "roborock-clean-rooms", device: "dev1", segments: "", names: "Bath", mapFlag: "2", repeat: "1", fan: "", mop: "", wires: [["out"]] },
                { id: "out", type: "helper" }
            ], CREDENTIALS);
            const out = collect("out");
            helper.getNode("n1").receive({});
            const result = await out.next();
            assert.equal(result.floorSwitched, true);
            assert.deepEqual(result.segments, [17]);
            const order = methods(mock);
            assert.ok(order.indexOf("load_multi_map") < order.indexOf("app_segment_clean"));
            assert.equal(state.loaded, 2);
        } finally {
            await mock.close();
        }
    });

    test("clean-rooms cleans nothing when the floor cannot be loaded", async () => {
        const state = { loaded: 1, state: 5 };
        const mock = await twoFloorMock(state);
        try {
            await helper.load(register, [
                deviceNode(mock),
                { id: "n1", type: "roborock-clean-rooms", device: "dev1", segments: "16", names: "", mapFlag: "2", repeat: "1", fan: "turbo", mop: "", wires: [[]] },
                { id: "n2", type: "roborock-clean-rooms", device: "dev1", segments: "", names: "", mapFlag: "", repeat: "1", fan: "", mop: "", wires: [[]] },
                { id: "c1", type: "catch", scope: null, uncaught: false, wires: [["err"]] },
                { id: "err", type: "helper" }
            ], CREDENTIALS);
            const err = collect("err");
            helper.getNode("n1").receive({});
            assert.match((await err.next()).error.message, /cleaning/);
            assert.equal(methods(mock).includes("app_segment_clean"), false);
            assert.equal(methods(mock).includes("set_custom_mode"), false);

            helper.getNode("n2").receive({});
            assert.match((await err.next()).error.message, /No rooms to clean/);

            helper.getNode("n2").receive({ segments: ["abc"] });
            assert.match((await err.next()).error.message, /not a valid id/);
        } finally {
            await mock.close();
        }
    });

    test("the universal vacuum node still sends unknown and raw methods, and keeps the incoming message", async () => {
        const mock = await startMock();
        try {
            await helper.load(register, [
                deviceNode(mock),
                { id: "n1", type: "roborock-vacuum", device: "dev1", pollInterval: 0, statusOnChange: true, wires: [["out"], []] },
                { id: "out", type: "helper" }
            ], CREDENTIALS);
            const out = collect("out");
            helper.getNode("n1").receive({ topic: "raw", payload: { method: "some_new_method", params: [1, 2] } });
            const result = await out.next();
            assert.equal(result.topic, "raw");
            assert.equal(result.method, "some_new_method");
            const sent = mock.requests.find((rpc) => rpc.method === "some_new_method");
            assert.deepEqual(sent.params, [1, 2]);

            helper.getNode("n1").receive({ payload: "some_other_method" });
            assert.equal((await out.next()).method, "some_other_method");
        } finally {
            await mock.close();
        }
    });

    test("clean-rooms ignores a numeric, string, or boolean payload and only reads explicit rooms", async () => {
        const state = { loaded: 1, state: 8 };
        const mock = await twoFloorMock(state);
        try {
            await helper.load(register, [
                deviceNode(mock),
                { id: "n1", type: "roborock-clean-rooms", device: "dev1", segments: "20", names: "", mapFlag: "", repeat: "1", fan: "", mop: "", wires: [["out"]] },
                { id: "c1", type: "catch", scope: null, uncaught: false, wires: [["err"]] },
                { id: "out", type: "helper" },
                { id: "err", type: "helper" }
            ], CREDENTIALS);
            const out = collect("out");
            const n1 = helper.getNode("n1");
            for (const payload of [1791403200000, 0, 5, true, false, "Kitchen", "16", null, "", { unrelated: 1 }]) {
                n1.receive({ payload });
                const result = await out.next();
                assert.deepEqual(result.segments, [20], `payload ${JSON.stringify(payload)} must not replace the node's rooms`);
            }
            const cleans = mock.requests.filter((rpc) => rpc.method === "app_segment_clean");
            assert.equal(cleans.length, 10);
            for (const clean of cleans) {
                assert.deepEqual(clean.params, [{ segments: [20], repeat: 1 }]);
            }

            n1.receive({ payload: [21] });
            assert.deepEqual((await out.next()).segments, [21]);
            n1.receive({ payload: { segments: [16] } });
            assert.deepEqual((await out.next()).segments, [16]);
            n1.receive({ payload: { rooms: [17] } });
            assert.deepEqual((await out.next()).segments, [17]);
            n1.receive({ rooms: [22], payload: 1791403200000 });
            assert.deepEqual((await out.next()).segments, [22]);
            n1.receive({ segments: [23], payload: 1791403200000 });
            assert.deepEqual((await out.next()).segments, [23]);
        } finally {
            await mock.close();
        }
    });

    test("vacuum fan and mop shorthand send one-element lists", async () => {
        const mock = await startMock();
        try {
            await helper.load(register, [
                deviceNode(mock),
                { id: "n1", type: "roborock-vacuum", device: "dev1", pollInterval: 0, statusOnChange: true, wires: [["out"], []] },
                { id: "out", type: "helper" }
            ], CREDENTIALS);
            const out = collect("out");
            const n1 = helper.getNode("n1");
            n1.receive({ payload: { command: "fan", speed: "turbo" } });
            await out.next();
            n1.receive({ payload: { command: "mop", intensity: "medium" } });
            await out.next();
            assert.deepEqual(mock.requests.find((rpc) => rpc.method === "set_custom_mode").params, [103]);
            assert.deepEqual(mock.requests.find((rpc) => rpc.method === "set_water_box_custom_mode").params, [202]);
        } finally {
            await mock.close();
        }
    });

    test("auto falls back to L01 when the account says 1.0, and remembers it per device", async () => {
        const mock = await startMock(undefined, { versions: ["L01"] });
        const device = { ...deviceNode(mock), pv: "1.0", helloTimeoutMs: 250 };
        try {
            await helper.load(register, [
                device,
                { id: "n1", type: "roborock-command", device: "dev1", action: "start", wires: [["out"]] },
                { id: "out", type: "helper" }
            ], { dev1: { ...CREDENTIALS.dev1, duid: "DUIDL01" } });
            const out = collect("out");
            helper.getNode("n1").receive({});
            assert.equal((await out.next(10000)).method, "app_start");
            assert.ok(mock.helloVersions.includes("1.0"), "the account's 1.0 was tried first");
            assert.ok(mock.helloVersions.includes("L01"));
            assert.equal(sessionPool.peek("dev1").client.version, "L01");
            const file = JSON.parse(fs.readFileSync(protocolCacheFile(path.join(os.tmpdir(), `roborock-split-${process.pid}`)), "utf8"));
            assert.equal(file.devices.DUIDL01, "L01");
            assert.equal(JSON.stringify(file).includes("testlocalkey"), false);

            resetForTests();
            const before = mock.helloVersions.length;
            await helper.unload();
            await helper.load(register, [
                device,
                { id: "n1", type: "roborock-command", device: "dev1", action: "pause", wires: [["out"]] },
                { id: "out", type: "helper" }
            ], { dev1: { ...CREDENTIALS.dev1, duid: "DUIDL01" } });
            const again = collect("out");
            helper.getNode("n1").receive({});
            assert.equal((await again.next(10000)).method, "app_pause");
            assert.deepEqual(mock.helloVersions.slice(before).filter((version) => version === "1.0"), [], "the remembered L01 is tried first and no 1.0 hello is wasted");
        } finally {
            await mock.close();
        }
    });

    test("a forced protocol is not second-guessed", async () => {
        const mock = await startMock(undefined, { versions: ["L01"] });
        try {
            await helper.load(register, [
                { ...deviceNode(mock), protocol: "1.0", helloTimeoutMs: 200 },
                { id: "n1", type: "roborock-command", device: "dev1", action: "start", wires: [[]] }
            ], CREDENTIALS);
            await new Promise((resolve) => setTimeout(resolve, 1200));
            assert.equal(mock.helloVersions.includes("L01"), false);
            assert.ok(mock.helloVersions.includes("1.0"));
        } finally {
            await mock.close();
        }
    });

    test("status and consumables keep the incoming topic; events never carry an incoming message", async () => {
        let state = { state: 8, battery: 80, error_code: 0 };
        const mock = await startMock((rpc) => (rpc.method === "get_status" ? [state] : undefined));
        try {
            await helper.load(register, [
                deviceNode(mock),
                { id: "n1", type: "roborock-status", device: "dev1", pollInterval: 0, statusOnChange: true, lowBattery: 0, wires: [["status"], ["events"]] },
                { id: "status", type: "helper" },
                { id: "events", type: "helper" }
            ], CREDENTIALS);
            const status = collect("status");
            const events = collect("events");
            const n1 = helper.getNode("n1");
            n1.receive({ topic: "first" });
            const first = await status.next();
            assert.equal(first.topic, "first");
            assert.equal(first.kind, "status");

            // A background sample that changes state arrives while an on-demand read is in flight.
            n1.receive({ topic: "ask", custom: 7 });
            await new Promise((resolve) => setImmediate(resolve));
            const client = sessionPool.peek("dev1").client;
            client.emit("status", { state: 5, stateName: "cleaning", battery: 80, errorCode: 0, inCleaning: 1 });
            const started = await events.next();
            assert.equal(started.payload, "cleaning-started");
            assert.equal(started.event, "cleaning-started");
            assert.equal(started.kind, "event");
            assert.equal("topic" in started, false, "a background event must not borrow the on-demand message");
            assert.equal("custom" in started, false);
            const answer = await status.next();
            assert.equal(answer.topic, "ask");
            assert.equal(answer.custom, 7);
            assert.equal(answer.kind, "status");
        } finally {
            await mock.close();
        }
    });

    test("overlapping on-demand reads each answer their own message and add no stray status", async () => {
        const mock = await startMock((rpc) => (rpc.method === "get_status" ? [{ state: 8, battery: 80, error_code: 0 }] : undefined));
        try {
            await helper.load(register, [
                deviceNode(mock),
                { id: "n1", type: "roborock-status", device: "dev1", pollInterval: 0, statusOnChange: true, lowBattery: 0, wires: [["status"], ["events"]] },
                { id: "status", type: "helper" },
                { id: "events", type: "helper" }
            ], CREDENTIALS);
            const status = collect("status");
            const n1 = helper.getNode("n1");
            n1.receive({ topic: "a" });
            n1.receive({ topic: "b" });
            n1.receive({ topic: "c" });
            const topics = [];
            for (let index = 0; index < 3; index += 1) {
                topics.push((await status.next()).topic);
            }
            assert.deepEqual(topics.sort(), ["a", "b", "c"]);
            await new Promise((resolve) => setTimeout(resolve, 200));
            assert.equal(status.messages.length, 0, "no extra status without a topic");
        } finally {
            await mock.close();
        }
    });

    test("an error names what is missing on the device", async () => {
        const mock = await startMock();
        try {
            await helper.load(register, [
                { ...deviceNode(mock), id: "noKey" },
                { ...deviceNode(mock), id: "noIp" },
                { ...deviceNode(mock), id: "neither" },
                { id: "a", type: "roborock-command", device: "noKey", action: "start", wires: [[]] },
                { id: "b", type: "roborock-command", device: "noIp", action: "start", wires: [[]] },
                { id: "c", type: "roborock-command", device: "neither", action: "start", wires: [[]] },
                { id: "d", type: "roborock-command", device: "", action: "start", wires: [[]] },
                { id: "c1", type: "catch", scope: null, uncaught: false, wires: [["err"]] },
                { id: "err", type: "helper" }
            ], {
                noKey: { ip: "127.0.0.1", duid: "D" },
                noIp: { localKey: "testlocalkey1234", duid: "D" },
                neither: { duid: "D" }
            });
            const err = collect("err");
            const expectations = { a: /missing its local key/, b: /missing its IP\b/, c: /missing its IP and local key/, d: /No roborock device is selected/ };
            for (const [id, pattern] of Object.entries(expectations)) {
                helper.getNode(id).receive({});
                const failure = await err.next();
                assert.match(failure.error.message, pattern, id);
                assert.doesNotMatch(failure.error.message, /IP or local key/);
            }
            const texts = helper.getNode("a").status.args.map((call) => call[0].text).slice(-4);
            assert.deepEqual(texts, ["set local key", "set IP", "set IP and local key", "select a device"]);
        } finally {
            await mock.close();
        }
    });

    test("maps load of the floor that is already loaded sends no load_multi_map, even while cleaning", async () => {
        const state = { loaded: 1, state: 5 };
        const mock = await twoFloorMock(state);
        try {
            await helper.load(register, [
                deviceNode(mock),
                { id: "n1", type: "roborock-maps", device: "dev1", action: "load", mapFlag: "1", wires: [["out"]] },
                { id: "out", type: "helper" }
            ], CREDENTIALS);
            const out = collect("out");
            helper.getNode("n1").receive({});
            const result = await out.next();
            assert.equal(result.payload.currentMapFlag, 1);
            assert.equal(result.payload.alreadyLoaded, true);
            assert.equal(methods(mock).includes("load_multi_map"), false);
        } finally {
            await mock.close();
        }
    });

    test("dock retries once after action locked, other actions and other errors do not", async () => {
        setDockRetryMsForTests(80);
        let chargeCalls = 0;
        let alwaysLocked = false;
        const mock = await startMock((rpc) => {
            if (rpc.method === "app_charge") {
                chargeCalls += 1;
                if (alwaysLocked || chargeCalls === 1) {
                    throw new Error("action locked (-10003)");
                }
            }
            if (rpc.method === "app_start") {
                throw new Error("action locked (-10003)");
            }
            if (rpc.method === "app_stop") {
                throw new Error("something else");
            }
            return undefined;
        });
        try {
            await helper.load(register, [
                deviceNode(mock),
                { id: "n1", type: "roborock-command", device: "dev1", action: "dock", wires: [["out"]] },
                { id: "c1", type: "catch", scope: null, uncaught: false, wires: [["err"]] },
                { id: "out", type: "helper" },
                { id: "err", type: "helper" }
            ], CREDENTIALS);
            const out = collect("out");
            const err = collect("err");
            const n1 = helper.getNode("n1");
            n1.receive({ topic: "go" });
            const result = await out.next();
            assert.equal(result.method, "app_charge");
            assert.equal(result.retried, true);
            assert.equal(result.topic, "go");
            assert.equal(chargeCalls, 2);

            n1.receive({});
            const clean = await out.next();
            assert.equal("retried" in clean, false);
            assert.equal(chargeCalls, 3);

            alwaysLocked = true;
            n1.receive({});
            assert.match((await err.next()).error.message, /action locked/);
            assert.equal(chargeCalls, 5, "one retry only");

            n1.receive({ payload: "start" });
            assert.match((await err.next()).error.message, /action locked/);
            assert.equal(mock.requests.filter((rpc) => rpc.method === "app_start").length, 1, "start is not retried");

            n1.receive({ payload: "stop" });
            assert.match((await err.next()).error.message, /something else/);
            assert.equal(mock.requests.filter((rpc) => rpc.method === "app_stop").length, 1);
        } finally {
            setDockRetryMsForTests(-1);
            await mock.close();
        }
    });

    test("a failed command shows red, then the status line returns to the robot state", async () => {
        const mock = await startMock();
        setFailureStatusMsForTests(150);
        try {
            await helper.load(register, [
                deviceNode(mock),
                { id: "n1", type: "roborock-command", device: "dev1", action: "start", wires: [["out"]] },
                { id: "c1", type: "catch", scope: null, uncaught: false, wires: [["err"]] },
                { id: "out", type: "helper" },
                { id: "err", type: "helper" }
            ], CREDENTIALS);
            const out = collect("out");
            const err = collect("err");
            const n1 = helper.getNode("n1");
            n1.receive({});
            await out.next();
            n1.receive({ payload: "bogus" });
            await err.next();
            const lastStatus = () => n1.status.lastCall.args[0];
            assert.equal(lastStatus().fill, "red");
            await new Promise((resolve) => setTimeout(resolve, 400));
            assert.notEqual(lastStatus().fill, "red");
            assert.match(lastStatus().text, /^(connected|charging 87%)$/);
        } finally {
            setFailureStatusMsForTests(0);
            await mock.close();
        }
    });
});

describe("package layout", () => {
    const root = path.join(__dirname, "..");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const added = ["command", "status", "clean-rooms", "settings", "maps", "consumables", "vacuum", "device", "account"].map((name) => `roborock-${name}`);
    const flowNodes = ["command", "status", "clean-rooms", "settings", "maps", "consumables", "vacuum"].map((name) => `roborock-${name}`);
    const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

    test("every registered node has its files, and the new nodes have English and Russian text and help", () => {
        for (const [type, file] of Object.entries(pkg["node-red"].nodes)) {
            assert.ok(fs.existsSync(path.join(root, file)), `${type} js`);
            assert.ok(fs.existsSync(path.join(root, file.replace(/\.js$/, ".html"))), `${type} html`);
        }
        for (const type of added) {
            assert.ok(pkg["node-red"].nodes[type], `${type} registered`);
            const en = JSON.parse(fs.readFileSync(path.join(root, "nodes/locales/en-US", `${type}.json`), "utf8"));
            const ru = JSON.parse(fs.readFileSync(path.join(root, "nodes/locales/ru", `${type}.json`), "utf8"));
            assert.deepEqual(keyPaths(en), keyPaths(ru), `${type} Russian text has the same keys`);
            for (const lang of ["en-US", "ru"]) {
                const help = fs.readFileSync(path.join(root, "nodes/locales", lang, `${type}.html`), "utf8");
                assert.ok(help.includes(`data-help-name="${type}"`), `${type} ${lang} help`);
            }
            const html = fs.readFileSync(path.join(root, "nodes", `${type}.html`), "utf8");
            const used = [...html.matchAll(/["'(]?(roborock-[a-z-]+\.[A-Za-z.]+)/g)].map((match) => match[1]).filter((key) => key.startsWith(`${type}.`));
            const known = new Set(keyPaths(en));
            const direct = [...html.matchAll(/\bt\("([A-Za-z.]+)"/g)].map((match) => `${type}.${match[1]}`);
            const conditional = [...html.matchAll(/\bt\(\w+\.ip \? "(\w+)" : "(\w+)"/g)].flatMap((match) => [match[1], match[2]].map((key) => `${type}.${key}`));
            for (const key of [...used, ...direct, ...conditional]) {
                const stem = key.replace(/\.$/, "");
                const exists = known.has(stem) || [...known].some((known_) => known_.startsWith(`${stem}.`));
                assert.ok(exists, `${type} uses missing text key ${key}`);
            }
        }
    });

    test("every node help has the same structure in English and Russian", () => {
        const headings = {
            "en-US": { flow: ["Inputs", "Outputs", "Details"], config: ["Fields", "Details"] },
            ru: { flow: ["Входы", "Выходы", "Подробности"], config: ["Поля", "Подробности"] }
        };
        for (const lang of ["en-US", "ru"]) {
            for (const type of added) {
                const help = read("nodes/locales", lang, `${type}.html`);
                const expected = flowNodes.includes(type) ? headings[lang].flow : headings[lang].config;
                const found = [...help.matchAll(/<h3>([^<]+)<\/h3>/g)].map((match) => match[1]);
                assert.deepEqual(found, expected, `${type} ${lang} headings`);
                assert.match(help, /^<script type="text\/html" data-help-name="[a-z-]+">\n {4}<p>/, `${type} ${lang} starts with a one-line purpose`);
                assert.equal(help.match(/data-help-name/g).length, 1);
            }
        }
    });

    test("the docs describe what the nodes do: no miIO, no model-specific framing, no history", () => {
        const files = ["README.md", "package.json"];
        for (const dir of ["nodes", "nodes/locales/en-US", "nodes/locales/ru"]) {
            for (const name of fs.readdirSync(path.join(root, dir))) {
                if (/\.(html|json)$/.test(name)) {
                    files.push(path.join(dir, name));
                }
            }
        }
        const banned = /54321|miIO|\bS7\b|Downstairs|a15\b|python-miio|not implemented|no longer|used to be|previously|in an older version/;
        for (const file of files) {
            const text = read(file);
            const hit = text.match(banned);
            assert.equal(hit, null, `${file} mentions ${hit && hit[0]}`);
        }
        assert.match(read("README.md"), /S8 Pro Ultra/, "the L01-only finding is kept");
        for (const type of ["roborock-device"]) {
            for (const lang of ["en-US", "ru"]) {
                assert.match(read("nodes/locales", lang, `${type}.html`), /S8 Pro Ultra/);
            }
        }
    });

    test("the README and the help say rooms must be named in the Roborock app", () => {
        const needle = /named in the Roborock app|Name the rooms in the Roborock app/;
        assert.match(fs.readFileSync(path.join(root, "README.md"), "utf8"), needle);
        for (const lang of ["en-US", "ru"]) {
            for (const type of ["roborock-maps", "roborock-clean-rooms", "roborock-device", "roborock-vacuum"]) {
                const help = fs.readFileSync(path.join(root, "nodes/locales", lang, `${type}.html`), "utf8");
                assert.match(help, lang === "ru" ? /в приложении Roborock/ : needle, `${type} ${lang} help`);
            }
        }
        const picker = JSON.parse(fs.readFileSync(path.join(root, "nodes/locales/en-US/roborock-clean-rooms.json"), "utf8"));
        assert.match(picker["roborock-clean-rooms"].notes.noMapping, needle);
        const picker_ru = JSON.parse(fs.readFileSync(path.join(root, "nodes/locales/ru/roborock-clean-rooms.json"), "utf8"));
        assert.match(picker_ru["roborock-clean-rooms"].notes.noMapping, /в приложении Roborock/);
    });

    test("the room picker maps the library's no-mapping note to its translation", () => {
        const { NO_ROOM_MAPPING } = require("../lib/maps");
        const html = fs.readFileSync(path.join(root, "nodes/roborock-clean-rooms.html"), "utf8");
        assert.ok(html.includes(`"${NO_ROOM_MAPPING}": "noMapping"`));
    });

    test("the example flows only reference node types that exist and carry no secrets", () => {
        const core = new Set(["tab", "comment", "inject", "debug", "function", "switch", "change", "delay", "link in", "link out", "catch"]);
        const examples = fs.readdirSync(path.join(root, "examples")).filter((name) => name.endsWith(".json"));
        assert.ok(examples.length >= 2);
        for (const file of examples) {
            const text = fs.readFileSync(path.join(root, "examples", file), "utf8");
            assert.equal(/"localKey"|"local_key"/.test(text), false, `${file} has no key`);
            const ids = new Set();
            const flow = JSON.parse(text);
            for (const node of flow) {
                assert.ok(core.has(node.type) || pkg["node-red"].nodes[node.type], `${file}: unknown type ${node.type}`);
                assert.equal(ids.has(node.id), false, `${file}: duplicate id ${node.id}`);
                ids.add(node.id);
            }
            for (const node of flow) {
                for (const output of node.wires || []) {
                    for (const target of output) {
                        assert.ok(ids.has(target), `${file}: ${node.id} wires to missing ${target}`);
                    }
                }
                if (node.device) {
                    assert.ok(ids.has(node.device), `${file}: ${node.id} uses missing device`);
                }
            }
        }
    });
});

function keyPaths(value, prefix = "") {
    return Object.entries(value).flatMap(([key, child]) => {
        const next = prefix ? `${prefix}.${key}` : key;
        return child && typeof child === "object" ? keyPaths(child, next) : [next];
    }).sort();
}
