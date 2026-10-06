"use strict";

/**
 * Multi-map helpers. Map names come from get_multi_maps_list.
 * Segment ids come from get_room_mapping for the map that is loaded.
 * Cloud home room names are not treated as segment names.
 */

function currentMapFlag(mapStatus) {
    const value = Number(mapStatus);
    // Known pattern only: 3, 7, 11, 15, ... -> flags 0, 1, 2, 3, ...
    // Other values (including ones that used to collapse to flag 0) stay unknown.
    if (!Number.isInteger(value) || value < 3 || (value - 3) % 4 !== 0) {
        return null;
    }
    return (value - 3) / 4;
}

function normalizeMapList(result) {
    const row = unwrap(result);
    const info = row && Array.isArray(row.map_info) ? row.map_info : [];
    return info.map((map) => {
        const mapFlag = Number(map.mapFlag);
        return {
            mapFlag,
            name: mapName(map.name) || `Map ${mapFlag}`,
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

function emptySegmentWarning({ mapName } = {}) {
    const where = mapName ? `the current map "${mapName}"` : "the current map";
    return `No segments returned for ${where}. Enter numbered segment ids by hand (for example 16), or load another map and read again. Cloud home room names are not used.`;
}

function describeMaps(maps, segments, currentMapFlagValue) {
    const names = (maps || []).map((map) => {
        return map.mapFlag === currentMapFlagValue ? `${map.name} (current)` : map.name;
    });
    const mapText = names.length ? `Maps: ${names.join(", ")}.` : "No saved maps returned.";
    const segText = (segments || []).map((segment) => segment.name).join(", ");
    return segText ? `${mapText} Segments on the current map: ${segText}.` : mapText;
}

function mapName(name) {
    // The S7 sends plain UTF-8. decodeURIComponent would rewrite a literal "%"
    // such as "Дом%20", so the name is kept exactly as the robot sent it.
    if (name === undefined || name === null) {
        return "";
    }
    return String(name);
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
