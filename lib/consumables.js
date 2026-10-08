"use strict";

const HOUR = 3600;

/**
 * Service life in seconds for each wear part, as used by python-roborock.
 * Fields that the robot does not report are skipped. Counter-style fields (strainer, cleaning brush)
 * are left in raw because their unit is not the same.
 */
const PARTS = [
    { key: "mainBrush", field: "main_brush_work_time", lifeSeconds: 300 * HOUR },
    { key: "sideBrush", field: "side_brush_work_time", lifeSeconds: 200 * HOUR },
    { key: "filter", field: "filter_work_time", lifeSeconds: 150 * HOUR },
    { key: "sensor", field: "sensor_dirty_time", lifeSeconds: 30 * HOUR }
];

function normalizeConsumables(result) {
    const row = Array.isArray(result) ? result[0] : result;
    if (!row || typeof row !== "object") {
        return null;
    }
    const parts = {};
    for (const part of PARTS) {
        const used = Number(row[part.field]);
        if (row[part.field] === undefined || row[part.field] === null || !Number.isFinite(used)) {
            continue;
        }
        const remainingSeconds = Math.max(0, part.lifeSeconds - used);
        parts[part.key] = {
            usedHours: round1(used / HOUR),
            remainingHours: round1(remainingSeconds / HOUR),
            remainingPercent: Math.round((remainingSeconds / part.lifeSeconds) * 100)
        };
    }
    return { parts, raw: row };
}

function lowParts(consumables, thresholdPercent) {
    const limit = Number(thresholdPercent);
    if (!consumables || !Number.isFinite(limit)) {
        return [];
    }
    return Object.keys(consumables.parts).filter((key) => consumables.parts[key].remainingPercent <= limit);
}

function round1(value) {
    return Math.round(value * 10) / 10;
}

module.exports = {
    PARTS,
    normalizeConsumables,
    lowParts
};
