"use strict";

const { normalizeStatus } = require("./status");
const { segmentIdForName } = require("./commands");
const { readDeviceCache, rememberLoadedRooms } = require("./map-cache");

/**
 * Multi-map helpers.
 *
 * get_multi_maps_list.map_info is the list of floors. On some firmware each
 * entry includes a rooms array (id, iot_name, iot_name_id). That is the only
 * read-only way to see rooms on a map that is not loaded.
 *
 * get_room_mapping returns segments for the loaded map only, as
 * [segmentId, cloudRoomId, tag]. The third value is a room-type tag, not a
 * map id. An empty array means the loaded map reported no segments. It does
 * not describe other floors. The editor can load another floor only after
 * an explicit confirmation, then caches that floor's rooms.
 *
 * Cloud home rooms are id -> name. A name is attached only when
 * get_room_mapping links that segment to that cloud room id. Unlinked home
 * rooms are ignored, even if the account still has old names.
 */

const ROOMS_WHEN_LOADED = "rooms visible when this map is loaded";
const NO_ROOM_MAPPING = "This map has no room mapping. Rooms must be named in the Roborock app at least once; until then the robot reports none.";
const MAPPING_UNREADABLE = "Room mapping could not be read for this map.";

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
        const entry = {
            mapFlag,
            name: mapName(map.name) || `Map ${mapFlag}`,
            length: map.length === undefined ? null : Number(map.length),
            // null: this firmware did not send per-map rooms.
            // []: it sent the field and this map has no rooms.
            rooms: Object.prototype.hasOwnProperty.call(map, "rooms")
                ? normalizeMapInfoRooms(map.rooms)
                : null
        };
        return entry;
    }).filter((map) => Number.isFinite(map.mapFlag));
}

function normalizeMapInfoRooms(rooms) {
    if (!Array.isArray(rooms)) {
        return [];
    }
    const segments = [];
    for (const room of rooms) {
        if (!room || typeof room !== "object") {
            continue;
        }
        const segmentId = Number(room.id);
        if (!Number.isFinite(segmentId)) {
            continue;
        }
        const segment = { segmentId };
        const iotName = mapName(room.iot_name).trim();
        if (iotName) {
            segment.iotName = iotName;
        }
        segments.push(segment);
    }
    return segments;
}

/**
 * Pairs from get_room_mapping. The optional third element is a room tag
 * and is not a map flag.
 */
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
        const segment = { segmentId };
        if (pair.length > 1 && pair[1] !== undefined && pair[1] !== null && String(pair[1]).trim() !== "") {
            segment.roomId = String(pair[1]).trim();
        }
        if (mapFlag !== undefined && mapFlag !== null) {
            segment.mapFlag = mapFlag;
        }
        segments.push(segment);
    }
    return segments;
}

function cloudNameForRoomId(roomId, cloudRooms) {
    if (roomId === undefined || roomId === null) {
        return "";
    }
    const id = String(roomId).trim();
    if (!id || id === "-1") {
        return "";
    }
    const list = Array.isArray(cloudRooms) ? cloudRooms : [];
    const match = list.find((room) => room && String(room.id) === id);
    if (!match || match.name === undefined || match.name === null) {
        return "";
    }
    return String(match.name).trim();
}

function withName(segmentId, name) {
    const entry = { segmentId };
    if (name) {
        entry.name = name;
    }
    return entry;
}

/**
 * One catalog for the editor and for {"command":"map_rooms"}.
 * Nothing in here switches the loaded map.
 */
function buildMapCatalog({ maps, mapping, currentMapFlag: currentFlag, cloudRooms, mappingError }) {
    const loaded = normalizeSegments(mapping).map((segment) => {
        return withName(segment.segmentId, cloudNameForRoomId(segment.roomId, cloudRooms));
    });
    const loadedById = new Map(loaded.map((segment) => [segment.segmentId, segment]));
    const knownCurrent = currentFlag !== undefined && currentFlag !== null && Number.isFinite(Number(currentFlag));
    const current = knownCurrent ? Number(currentFlag) : null;

    const list = (maps || []).map((map) => {
        const isCurrent = current !== null && map.mapFlag === current;
        const byId = new Map();
        if (Array.isArray(map.rooms)) {
            for (const room of map.rooms) {
                const fromCloud = isCurrent ? loadedById.get(room.segmentId) : null;
                const name = (fromCloud && fromCloud.name) || room.iotName || "";
                byId.set(room.segmentId, withName(room.segmentId, name));
            }
        }
        if (isCurrent) {
            for (const segment of loaded) {
                const prev = byId.get(segment.segmentId);
                if (prev && prev.name && !segment.name) {
                    continue;
                }
                const name = (segment.name) || (prev && prev.name) || "";
                byId.set(segment.segmentId, withName(segment.segmentId, name));
            }
        }
        const entry = {
            name: map.name,
            mapFlag: map.mapFlag,
            current: isCurrent,
            segments: [...byId.values()]
        };
        if (entry.segments.length === 0) {
            if (isCurrent && mappingError && !Array.isArray(map.rooms)) {
                entry.note = MAPPING_UNREADABLE;
            } else if (isCurrent || Array.isArray(map.rooms)) {
                entry.note = NO_ROOM_MAPPING;
            } else {
                entry.note = ROOMS_WHEN_LOADED;
            }
        }
        return entry;
    });

    const catalog = {
        currentMapFlag: current,
        maps: list
    };
    if (mappingError) {
        catalog.mappingError = mappingError;
    }
    if (current === null && loaded.length) {
        catalog.loadedSegments = loaded;
        catalog.loadedSegmentsNote = "These room ids are for the loaded map. Status did not report which floor that is, so they are not pinned to a map.";
    }
    return catalog;
}

async function readMapCatalog(request, cloudRooms, options = {}) {
    const status = normalizeStatus(await request("get_status", []));
    let maps = [];
    let mapsError = null;
    try {
        maps = normalizeMapList(await request("get_multi_maps_list", []));
    } catch (err) {
        mapsError = err.message;
    }
    let flag = status && status.mapStatus !== null && status.mapStatus !== undefined
        ? currentMapFlag(status.mapStatus)
        : null;
    if (options.currentMapFlag !== undefined && options.currentMapFlag !== null && Number.isFinite(Number(options.currentMapFlag))) {
        flag = Number(options.currentMapFlag);
    }
    let mapping = [];
    let mappingError = null;
    try {
        const raw = await request("get_room_mapping", []);
        mapping = Array.isArray(raw) ? raw : [];
    } catch (err) {
        mappingError = err.message;
    }
    const catalog = buildMapCatalog({
        maps,
        mapping,
        currentMapFlag: flag,
        cloudRooms,
        mappingError
    });
    if (mapsError) {
        catalog.mapsError = mapsError;
    }
    return { catalog, status };
}

function cloneSegments(segments) {
    return (segments || []).map((segment) => {
        const copy = { segmentId: segment.segmentId };
        if (segment.name) {
            copy.name = segment.name;
        }
        return copy;
    });
}

function cachedEntry(deviceCache, mapFlag) {
    if (!deviceCache || typeof deviceCache !== "object") {
        return null;
    }
    const entry = deviceCache[String(mapFlag)];
    if (!entry || !Array.isArray(entry.segments)) {
        return null;
    }
    return entry;
}

/**
 * Fill floors that were read earlier. Live map_info rooms win over the cache.
 * The loaded map keeps a fresh read. Its cache is used only when that read
 * failed, or to fill a name the fresh read did not have. Other floors' cache
 * is labeled cached so callers can tell it is not a live read.
 */
function applyCachedRooms(catalog, deviceCache) {
    if (!catalog || !Array.isArray(catalog.maps)) {
        return catalog;
    }
    for (const map of catalog.maps) {
        const cached = cachedEntry(deviceCache, map.mapFlag);
        if (!cached) {
            continue;
        }
        if (map.current) {
            if (catalog.mappingError && (!map.segments || map.segments.length === 0)) {
                map.segments = cloneSegments(cached.segments);
                map.cached = true;
                map.cachedAt = cached.cachedAt || null;
                if (map.segments.length) {
                    delete map.note;
                }
            } else {
                const byId = new Map((cached.segments || []).map((segment) => [segment.segmentId, segment]));
                for (const segment of map.segments || []) {
                    if (!segment.name) {
                        const prev = byId.get(segment.segmentId);
                        if (prev && prev.name) {
                            segment.name = prev.name;
                        }
                    }
                }
            }
            continue;
        }
        if (map.segments && map.segments.length) {
            continue;
        }
        map.segments = cloneSegments(cached.segments);
        map.cached = true;
        map.cachedAt = cached.cachedAt || null;
        if (map.segments.length) {
            delete map.note;
        }
    }
    return catalog;
}

async function readMapCatalogCached({ request, cloudRooms, userDir, duid, currentMapFlag: forcedFlag }) {
    const read = await readMapCatalog(request, cloudRooms, { currentMapFlag: forcedFlag });
    const cached = readDeviceCache(userDir, duid);
    applyCachedRooms(read.catalog, cached);
    await rememberLoadedRooms(userDir, duid, read.catalog);
    return read;
}

/**
 * Turn room labels into segment ids for the loaded map.
 * A name must match exactly one segment on that map, including names kept in
 * the cache for the loaded map. Cached names from any other floor are not
 * used. "16" and "Room 16" stay numeric ids. Unlinked cloud names are not targets.
 */
function resolveRoomTargets(names, catalog) {
    return (names || []).map((name) => resolveOneRoomName(name, catalog));
}

function namedHits(catalog, lower) {
    const current = [];
    const other = [];
    for (const map of (catalog && catalog.maps) || []) {
        for (const segment of map.segments || []) {
            if (!segment.name || String(segment.name).trim().toLowerCase() !== lower) {
                continue;
            }
            const hit = {
                segmentId: segment.segmentId,
                mapFlag: map.mapFlag,
                mapName: map.name
            };
            if (map.current) {
                current.push(hit);
            } else {
                other.push(hit);
            }
        }
    }
    if (!current.length) {
        for (const segment of (catalog && catalog.loadedSegments) || []) {
            if (segment.name && String(segment.name).trim().toLowerCase() === lower) {
                current.push({ segmentId: segment.segmentId, mapFlag: null, mapName: "" });
            }
        }
    }
    return { current, other };
}

function resolveOneRoomName(name, catalog) {
    const text = String(name == null ? "" : name).trim();
    const lower = text.toLowerCase();
    const { current, other } = namedHits(catalog, lower);
    const currentIds = [...new Set(current.map((hit) => hit.segmentId))];
    if (currentIds.length > 1) {
        throw new Error(`Room name "${text}" matches more than one segment (${currentIds.join(", ")}). Pass a segment id.`);
    }
    if (currentIds.length === 1) {
        return currentIds[0];
    }
    if (other.length) {
        const where = other.map((hit) => `${hit.mapName} (map ${hit.mapFlag})`).join(", ");
        const flag = other[0].mapFlag;
        throw new Error(`Room name "${text}" is on ${where}, which is not the loaded map. Switch with {"command":"map","mapFlag":${flag}} first, or pass a segment id.`);
    }
    return segmentIdForName(text, []);
}

function isPlainSegmentLabel(name) {
    return /^(?:room\s+)?\d+$/i.test(String(name == null ? "" : name).trim());
}

function emptySegmentWarning() {
    return NO_ROOM_MAPPING;
}

function describeMaps(maps, segments, currentMapFlagValue) {
    const names = (maps || []).map((map) => {
        return map.mapFlag === currentMapFlagValue ? `${map.name} (current)` : map.name;
    });
    const mapText = names.length ? `Maps: ${names.join(", ")}.` : "No saved maps returned.";
    const segText = (segments || []).map((segment) => segment.name || `Room ${segment.segmentId}`).join(", ");
    return segText ? `${mapText} Segments on the current map: ${segText}.` : mapText;
}

function mapName(name) {
    // The robot sends plain UTF-8. decodeURIComponent would rewrite a literal "%"
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
    ROOMS_WHEN_LOADED,
    NO_ROOM_MAPPING,
    MAPPING_UNREADABLE,
    currentMapFlag,
    normalizeMapList,
    normalizeSegments,
    emptySegmentWarning,
    describeMaps,
    buildMapCatalog,
    readMapCatalog,
    applyCachedRooms,
    readMapCatalogCached,
    resolveRoomTargets,
    isPlainSegmentLabel
};
