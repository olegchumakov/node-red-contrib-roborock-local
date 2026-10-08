"use strict";

const { isCleaning } = require("./status");

const EVENTS = [
    "cleaning-started",
    "cleaning-finished",
    "paused",
    "resumed",
    "error",
    "error-cleared",
    "low-battery"
];

const STATE_PAUSED = 10;

/**
 * A clean is in progress while the robot is cleaning or paused, or while its in_cleaning
 * flag is set. The flag stays set while paused and while returning to the dock, so a pause
 * is not the end of a clean and a resume is not the start of a new one.
 * When a sample has no in_cleaning (a pushed state change), the state alone decides.
 */
function inProgress(status) {
    if (!status) {
        return false;
    }
    if (isCleaning(status) || isPaused(status)) {
        return true;
    }
    if (status.inCleaning !== null && status.inCleaning !== undefined) {
        return Number(status.inCleaning) > 0;
    }
    return false;
}

function isPaused(status) {
    return Boolean(status) && Number(status.state) === STATE_PAUSED;
}

/**
 * Compare two normalized statuses and name what happened between them.
 * Nothing fires for the first sample (prev is null), because there is nothing to compare.
 * cleaning-finished fires when the clean stops being in progress: in_cleaning drops to 0 and the
 * robot is not paused or cleaning. The robot clears in_cleaning as soon as it is sent home (or
 * starts heading back by itself), so this happens when returning starts, not when it docks or
 * charges. A pause keeps in_cleaning set, so it is never a finish. low-battery fires once when the level drops to the threshold, and re-arms when
 * it climbs above.
 */
function detectEvents(prev, next, options = {}) {
    if (!prev || !next) {
        return [];
    }
    const events = [];
    const wasActive = inProgress(prev);
    const nowActive = inProgress(next);
    if (!wasActive && nowActive) {
        events.push("cleaning-started");
    }
    if (wasActive && !nowActive && !hasError(next)) {
        events.push("cleaning-finished");
    }
    if (!isPaused(prev) && isPaused(next)) {
        events.push("paused");
    }
    if (isPaused(prev) && !isPaused(next) && isCleaning(next)) {
        events.push("resumed");
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
    detectEvents,
    inProgress
};
