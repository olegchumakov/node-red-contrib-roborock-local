"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { detectEvents } = require("../lib/events");
const { normalizeConsumables, lowParts } = require("../lib/consumables");
const { resolveAction } = require("../lib/actions");

const paused = () => status({ state: 10, inCleaning: 1 });
const status = (fields) => ({ state: 8, battery: 80, errorCode: 0, ...fields });

describe("status events", () => {
    test("nothing fires without a previous sample", () => {
        assert.deepEqual(detectEvents(null, status({ state: 5 })), []);
    });

    test("cleaning start and finish", () => {
        assert.deepEqual(detectEvents(status({ state: 8 }), status({ state: 5 })), ["cleaning-started"]);
        assert.deepEqual(detectEvents(status({ state: 5 }), status({ state: 6 })), ["cleaning-finished"]);
        assert.deepEqual(detectEvents(status({ state: 5 }), status({ state: 18 })), []);
        assert.deepEqual(detectEvents(status({ state: 5 }), status({ state: 8 })), ["cleaning-finished"]);
    });

    test("a pause is not the end of a clean, and a resume is not a new start", () => {
        const cleaning = status({ state: 5, inCleaning: 1 });
        const paused = status({ state: 10, inCleaning: 1 });
        assert.deepEqual(detectEvents(cleaning, paused), ["paused"]);
        assert.deepEqual(detectEvents(paused, cleaning), ["resumed"]);
        assert.deepEqual(detectEvents(status({ state: 8, inCleaning: 0 }), cleaning), ["cleaning-started"]);
    });

    test("a paused segment clean keeps in_cleaning=3 and is still one clean", () => {
        const segment = status({ state: 18, inCleaning: 3 });
        const pausedSegment = status({ state: 10, inCleaning: 3 });
        assert.deepEqual(detectEvents(segment, pausedSegment), ["paused"]);
        assert.deepEqual(detectEvents(pausedSegment, segment), ["resumed"]);
        assert.deepEqual(detectEvents(pausedSegment, status({ state: 6, inCleaning: 3 })), []);
        assert.deepEqual(detectEvents(status({ state: 6, inCleaning: 3 }), status({ state: 8, inCleaning: 0 })), ["cleaning-finished"]);
    });

    test("cleaning-finished fires when the robot clears in_cleaning, at the start of the return", () => {
        const cleaning = status({ state: 5, inCleaning: 1 });
        assert.deepEqual(detectEvents(cleaning, status({ state: 6, inCleaning: 0 })), ["cleaning-finished"]);
        assert.deepEqual(detectEvents(status({ state: 6, inCleaning: 0 }), status({ state: 8, inCleaning: 0 })), []);
        assert.deepEqual(detectEvents(paused(), status({ state: 6, inCleaning: 0 })), ["cleaning-finished"]);
    });

    test("returning with in_cleaning still set is not finished yet", () => {
        const cleaning = status({ state: 5, inCleaning: 1 });
        const returning = status({ state: 6, inCleaning: 1 });
        assert.deepEqual(detectEvents(cleaning, returning), []);
        assert.deepEqual(detectEvents(returning, status({ state: 8, inCleaning: 0 })), ["cleaning-finished"]);
        assert.deepEqual(detectEvents(paused(), status({ state: 3, inCleaning: 0 })), ["cleaning-finished"]);
        assert.deepEqual(detectEvents(paused(), status({ state: 6, inCleaning: 1 })), []);
        assert.deepEqual(detectEvents(status({ state: 8, inCleaning: 1 }), status({ state: 5, inCleaning: 1 })), []);
    });

    test("an error that stops a clean is an error, not a finish", () => {
        assert.deepEqual(detectEvents(status({ state: 5 }), status({ state: 12, errorCode: 8 })), ["error"]);
        assert.deepEqual(detectEvents(status({ state: 12, errorCode: 8 }), status({ state: 8 })), ["error-cleared"]);
    });

    test("low battery fires once per drop to the threshold", () => {
        const options = { lowBattery: 20 };
        assert.deepEqual(detectEvents(status({ battery: 21 }), status({ battery: 20 }), options), ["low-battery"]);
        assert.deepEqual(detectEvents(status({ battery: 20 }), status({ battery: 19 }), options), []);
        assert.deepEqual(detectEvents(status({ battery: 30 }), status({ battery: 10 }), options), ["low-battery"]);
        assert.deepEqual(detectEvents(status({ battery: 21 }), status({ battery: 5 }), {}), []);
        assert.deepEqual(detectEvents(status({ battery: 21 }), status({ battery: 5 }), { lowBattery: 0 }), []);
    });
});

describe("consumables", () => {
    test("percent left from seconds worked, skipping fields the robot does not send", () => {
        const result = normalizeConsumables([{ main_brush_work_time: 150 * 3600, filter_work_time: 150 * 3600, sensor_dirty_time: 40 * 3600 }]);
        assert.equal(result.parts.mainBrush.remainingPercent, 50);
        assert.equal(result.parts.filter.remainingPercent, 0);
        assert.equal(result.parts.sensor.remainingHours, 0);
        assert.equal(result.parts.sideBrush, undefined);
        assert.deepEqual(lowParts(result, 10).sort(), ["filter", "sensor"]);
        assert.equal(normalizeConsumables(null), null);
    });
});

describe("plain actions", () => {
    test("known actions resolve, anything else is rejected", () => {
        assert.equal(resolveAction("start").method, "app_start");
        assert.equal(resolveAction(" Dock ").method, "app_charge");
        assert.equal(resolveAction("find").method, "find_me");
        assert.throws(() => resolveAction("strat"), /Unknown action/);
        assert.throws(() => resolveAction("get_status"), /roborock-vacuum/);
        assert.throws(() => resolveAction(""), /Unknown action/);
    });
});
