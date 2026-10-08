"use strict";

const { isCleaning } = require("./status");

const EVENTS = [
    "cleaning-started",
    "cleaning-finished",
    "error",
    "error-cleared",
    "low-battery"
];

/**
 * Compare two normalized statuses and name what happened between them.
 * Nothing fires for the first sample (prev is null), because there is nothing to compare.
 * low-battery fires once when the level drops to the threshold, and re-arms when it climbs above.
 */
function detectEvents(prev, next, options = {}) {
    if (!prev || !next) {
        return [];
    }
    const events = [];
    const wasCleaning = isCleaning(prev);
    const nowCleaning = isCleaning(next);
    if (!wasCleaning && nowCleaning) {
        events.push("cleaning-started");
    }
    if (wasCleaning && !nowCleaning && !hasError(next)) {
        events.push("cleaning-finished");
    }
    if (!hasError(prev) && hasError(next)) {
        events.push("error");
    }
    if (hasError(prev) && !hasError(next)) {
        events.push("error-cleared");
    }
    const threshold = Number(options.lowBattery);
    if (Number.isFinite(threshold) && threshold > 0
        && isNumber(prev.battery) && isNumber(next.battery)
        && prev.battery > threshold && next.battery <= threshold) {
        events.push("low-battery");
    }
    return events;
}

function hasError(status) {
    return Boolean(status) && Number(status.errorCode) > 0;
}

function isNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

module.exports = {
    EVENTS,
    detectEvents
};
