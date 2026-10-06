"use strict";

/**
 * Multi-map helpers. Map names come from get_multi_maps_list.
 * Segment ids come from get_room_mapping for the map that is loaded.
 * Cloud home room names are not treated as segment names.
 */

function currentMapFlag(mapStatus) {
    const value = Number(mapStatus);
    if (!Number.isFinite(value)) {
        return null;
    }
    // python-miio: map_status 3, 7, 11, 15 -> map flags 0, 1, 2, 3.
    const flag = Math.trunc((value + 1) / 4 - 1);
    if (flag > 0) {
        return flag;
    }
    return Object.is(flag, 0) ? 0 : null;
}

function normalizeMapList(result) {
    const row = unwrap(result);
    const info = row && Array.isArray(row.map_info) ? row.map_info : [];
    return info.map((map) => {
        const mapFlag = Number(map.mapFlag);
        return {
            mapFlag,
            name: decodeMapName(map.name) || `Map ${mapFlag}`,
            length: map.length === undefined ? null : Number(map.length)
        };
    }).filter((map) => Number.isFinite(map.mapFlag));
}

function normalizeSegments(mapping, mapFlag) {
    if (!Array.isArray(mapping)) {
        return [];
    }
    const segments = [];
    for (const pair of mapping) {
        if (!Array.isArray(pair) || pair.length === 0) {
            continue;
        }
        const segmentId = Number(pair[0]);
        if (!Number.isFinite(segmentId)) {
            continue;
        }
        const segment = {
            segmentId,
            name: `Room ${segmentId}`
        };
        if (mapFlag !== undefined && mapFlag !== null) {
            segment.mapFlag = mapFlag;
        }
        segments.push(segment);
    }
    return segments;
}

function emptySegmentWarning({ mapName, labStatus, unsaveMapFlag } = {}) {
    const where = mapName ? `the current map "${mapName}"` : "the current map";
    const bits = [];
    if (labStatus !== undefined && labStatus !== null && labStatus !== "") {
        bits.push(`lab_status ${labStatus}`);
    }
    if (unsaveMapFlag !== undefined && unsaveMapFlag !== null && unsaveMapFlag !== "") {
        bits.push(`unsave_map_flag ${unsaveMapFlag}`);
    }
    const status = bits.length
        ? ` Status reported ${bits.join(", ")}, which often means this map has no saved room splits.`
        : "";
    return `No segments returned for ${where}.${status} Numbered rooms still clean by segment id: enter them by hand (for example 16), or load another map and read again. Cloud home room names are not segment ids and are not used.`;
}

function describeMaps(maps, segments, currentMapFlagValue) {
    const names = (maps || []).map((map) => {
        return map.mapFlag === currentMapFlagValue ? `${map.name} (current)` : map.name;
    });
    const mapText = names.length ? `Maps: ${names.join(", ")}.` : "No saved maps returned.";
    const segText = (segments || []).map((segment) => segment.name).join(", ");
    return segText ? `${mapText} Segments on the current map: ${segText}.` : mapText;
}

function decodeMapName(name) {
    if (name === undefined || name === null || name === "") {
        return "";
    }
    const text = String(name);
    try {
        return decodeURIComponent(text);
    } catch (_err) {
        return text;
    }
}

function unwrap(result) {
    if (Array.isArray(result)) {
        return result[0] && typeof result[0] === "object" ? result[0] : null;
    }
    if (result && typeof result === "object") {
        return result;
    }
    return null;
}

module.exports = {
    currentMapFlag,
    normalizeMapList,
    normalizeSegments,
    emptySegmentWarning,
    describeMaps
};
