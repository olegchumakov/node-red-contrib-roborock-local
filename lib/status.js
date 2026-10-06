"use strict";

/** Human-readable vacuum state and error names, aligned with python-roborock. */

const STATES = {
    0: "unknown",
    1: "starting",
    2: "charger disconnected",
    3: "idle",
    4: "remote control",
    5: "cleaning",
    6: "returning",
    7: "manual",
    8: "charging",
    9: "charging problem",
    10: "paused",
    11: "spot cleaning",
    12: "error",
    13: "shutting down",
    14: "updating",
    15: "docking",
    16: "going to target",
    17: "zoned cleaning",
    18: "segment cleaning",
    22: "emptying bin",
    23: "washing mop",
    25: "washing mop",
    26: "going to wash mop",
    28: "in call",
    29: "mapping",
    30: "egg attack",
    32: "patrol",
    33: "attaching mop",
    34: "detaching mop",
    100: "charging complete",
    101: "offline",
    103: "locked",
    202: "drying stopping",
    6301: "mopping",
    6302: "clean mop cleaning",
    6303: "clean mop mopping",
    6304: "segment mopping",
    6305: "segment clean mop cleaning",
    6306: "segment clean mop mopping",
    6307: "zoned mopping",
    6308: "zoned clean mop cleaning",
    6309: "zoned clean mop mopping",
    6310: "returning to wash mop"
};

const ERRORS = {
    0: "none",
    1: "lidar blocked",
    2: "bumper stuck",
    3: "wheels suspended",
    4: "cliff sensor error",
    5: "main brush jammed",
    6: "side brush jammed",
    7: "wheels jammed",
    8: "robot trapped",
    9: "no dustbin",
    10: "filter wet or blocked",
    11: "strong magnetic field",
    12: "low battery",
    13: "charging error",
    14: "battery error",
    15: "wall sensor dirty",
    16: "robot tilted",
    17: "side brush error",
    18: "fan error",
    19: "dock not powered",
    20: "optical sensor dirty",
    21: "vertical bumper pressed",
    22: "dock locator error",
    23: "return to dock failed",
    24: "no-go zone detected",
    25: "camera error",
    26: "wall sensor error",
    27: "vibraRise jammed",
    28: "robot on carpet",
    29: "filter blocked",
    30: "invisible wall detected",
    31: "cannot cross carpet",
    32: "internal error",
    34: "auto-empty dock needs cleaning",
    35: "auto-empty dock voltage error",
    36: "wash roller jammed",
    37: "wash roller not lowered",
    38: "check clean water tank",
    39: "check dirty water tank",
    40: "reinstall water filter",
    41: "clean water tank empty",
    42: "water filter not installed",
    43: "positioning button error",
    44: "clean the dock water filter",
    45: "wash roller jammed",
    48: "clean water supply error",
    49: "drain water error",
    51: "temperature protection",
    52: "cleaning tray error",
    53: "cleaning tray water full",
    54: "water carriage dropped",
    55: "check cleaning tray",
    56: "audio error"
};

/** S7-class custom modes. Older firmware may want 38/60/77/90; pass a number for those. */
const FAN_SPEEDS = {
    silent: 101,
    quiet: 101,
    balanced: 102,
    standard: 102,
    normal: 102,
    turbo: 103,
    max: 104,
    "max+": 104,
    gentle: 105,
    off: 105,
    auto: 106
};

const FAN_NAMES = {
    38: "silent",
    60: "standard",
    75: "medium",
    77: "medium",
    90: "turbo",
    100: "turbo",
    101: "silent",
    102: "balanced",
    103: "turbo",
    104: "max",
    105: "gentle",
    106: "auto"
};

const MOP_INTENSITIES = {
    off: 200,
    low: 201,
    medium: 202,
    mid: 202,
    high: 203,
    custom: 207
};

const DPS = {
    ERROR: "120",
    STATE: "121",
    BATTERY: "122",
    FAN: "123",
    WATER: "124"
};

function stateName(code) {
    if (code === undefined || code === null || code === "") {
        return null;
    }
    const numeric = Number(code);
    return STATES[numeric] || `state ${numeric}`;
}

function errorName(code) {
    if (code === undefined || code === null || code === "") {
        return null;
    }
    const numeric = Number(code);
    return ERRORS[numeric] || (numeric === 0 ? "none" : `error ${numeric}`);
}

function statusColor(state) {
    const name = stateName(state) || "";
    if (name === "error" || name === "charging problem") {
        return "red";
    }
    if (name === "cleaning" || name === "spot cleaning" || name === "segment cleaning" || name === "zoned cleaning" || name === "mopping" || name === "mapping" || name === "patrol") {
        return "blue";
    }
    if (name === "returning" || name === "docking" || name === "paused" || name === "going to target" || name === "updating") {
        return "yellow";
    }
    if (name === "charging" || name === "charging complete" || name === "idle") {
        return "green";
    }
    return "grey";
}

function statusText(status) {
    if (!status) {
        return "connected";
    }
    const name = status.stateName || "unknown";
    if (status.errorCode && name === "error") {
        const label = status.errorName && status.errorName !== "none" ? status.errorName : name;
        return status.battery === undefined || status.battery === null ? label : `${label} ${status.battery}%`;
    }
    if (status.battery === undefined || status.battery === null) {
        return name;
    }
    return `${name} ${status.battery}%`;
}

function normalizeStatus(result) {
    const row = unwrapStatus(result);
    if (!row || typeof row !== "object") {
        return null;
    }
    const state = pick(row, "state");
    const battery = pick(row, "battery");
    const errorCode = pick(row, "error_code", "errorCode");
    const fanPower = pick(row, "fan_power", "fanPower");
    const cleanTime = pick(row, "clean_time", "cleanTime");
    const cleanArea = pick(row, "clean_area", "cleanArea");
    const inCleaning = pick(row, "in_cleaning", "inCleaning");
    const inReturning = pick(row, "in_returning", "inReturning");
    const waterBoxMode = pick(row, "water_box_mode", "waterBoxMode");
    const status = {
        state: state === undefined ? null : Number(state),
        stateName: stateName(state),
        battery: battery === undefined ? null : Number(battery),
        errorCode: errorCode === undefined ? null : Number(errorCode),
        errorName: errorName(errorCode),
        fanPower: fanPower === undefined ? null : Number(fanPower),
        fanName: FAN_NAMES[Number(fanPower)] || null,
        waterBoxMode: waterBoxMode === undefined ? null : Number(waterBoxMode),
        cleanTime: cleanTime === undefined ? null : Number(cleanTime),
        cleanArea: cleanArea === undefined ? null : Number(cleanArea),
        cleanAreaM2: cleanArea === undefined ? null : Math.round((Number(cleanArea) / 1000000) * 10) / 10,
        inCleaning: inCleaning === undefined ? null : Number(inCleaning),
        inReturning: inReturning === undefined ? null : Number(inReturning),
        raw: row
    };
    return status;
}

function statusFromDps(dps) {
    if (!dps || typeof dps !== "object") {
        return null;
    }
    const partial = {};
    if (dps[DPS.STATE] !== undefined || dps[121] !== undefined) {
        partial.state = Number(dps[DPS.STATE] ?? dps[121]);
    }
    if (dps[DPS.BATTERY] !== undefined || dps[122] !== undefined) {
        partial.battery = Number(dps[DPS.BATTERY] ?? dps[122]);
    }
    if (dps[DPS.ERROR] !== undefined || dps[120] !== undefined) {
        partial.error_code = Number(dps[DPS.ERROR] ?? dps[120]);
    }
    if (dps[DPS.FAN] !== undefined || dps[123] !== undefined) {
        partial.fan_power = Number(dps[DPS.FAN] ?? dps[123]);
    }
    if (dps[DPS.WATER] !== undefined || dps[124] !== undefined) {
        partial.water_box_mode = Number(dps[DPS.WATER] ?? dps[124]);
    }
    if (Object.keys(partial).length === 0) {
        return null;
    }
    return normalizeStatus(partial);
}

function unwrapStatus(result) {
    if (Array.isArray(result)) {
        return result[0] && typeof result[0] === "object" ? result[0] : null;
    }
    if (result && typeof result === "object") {
        return result;
    }
    return null;
}

function pick(obj, ...keys) {
    for (const key of keys) {
        if (obj[key] !== undefined && obj[key] !== null) {
            return obj[key];
        }
    }
    return undefined;
}

function sameStatus(left, right) {
    if (!left || !right) {
        return false;
    }
    return left.state === right.state
        && left.battery === right.battery
        && left.errorCode === right.errorCode
        && left.fanPower === right.fanPower
        && left.inCleaning === right.inCleaning
        && left.inReturning === right.inReturning;
}

module.exports = {
    STATES,
    ERRORS,
    FAN_SPEEDS,
    FAN_NAMES,
    MOP_INTENSITIES,
    stateName,
    errorName,
    statusColor,
    statusText,
    normalizeStatus,
    statusFromDps,
    sameStatus
};
