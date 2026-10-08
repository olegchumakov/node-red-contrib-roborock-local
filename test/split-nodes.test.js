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
            assert.equal(first.topic, "status");
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
            assert.equal(result.topic, "consumables");
            assert.equal(result.payload.parts.mainBrush.remainingPercent, 10);
            assert.equal(result.payload.parts.mainBrush.remainingHours, 30);
            assert.equal(result.payload.parts.filter.remainingPercent, 33);
            assert.deepEqual(result.low, ["mainBrush"]);
            const alert = await low.next();
            assert.deepEqual(alert.payload, ["mainBrush"]);

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
    const added = ["command", "status", "clean-rooms", "settings", "maps", "consumables"].map((name) => `roborock-${name}`);

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
            for (const key of used) {
                const stem = key.replace(/\.$/, "");
                const exists = known.has(stem) || [...known].some((known_) => known_.startsWith(`${stem}.`));
                assert.ok(exists, `${type} uses missing text key ${key}`);
            }
        }
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
