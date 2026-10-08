"use strict";

const { FAN_SPEEDS, FAN_NAMES, MOP_INTENSITIES } = require("./status");

const SHORT_COMMANDS = {
    start: ["app_start", []],
    resume: ["app_start", []],
    pause: ["app_pause", []],
    stop: ["app_stop", []],
    dock: ["app_charge", []],
    home: ["app_charge", []],
    charge: ["app_charge", []],
    return: ["app_charge", []],
    find: ["find_me", []],
    locate: ["find_me", []],
    status: ["get_status", []],
    spot: ["app_spot", []],
    mapping: ["get_room_mapping", []],
    rooms_map: ["get_room_mapping", []],
    network: ["get_network_info", []],
    consumables: ["get_consumable", []]
};

/**
 * Turn a Node-RED payload into a local RPC method and params.
 * Strings are shorthand (start, pause, dock, status, ...).
 * Objects may be shorthand or a raw {method, params} call.
 */
function resolveCommand(payload, fallback) {
    const value = payload === undefined || payload === null || payload === "" ? fallback : payload;
    if (value === undefined || value === null || value === "") {
        throw new Error("No command. Send start, pause, stop, dock, find, status, or {command, params}");
    }
    if (typeof value === "string") {
        return fromShorthand(value.trim().toLowerCase(), {});
    }
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Command payload must be a string or an object");
    }
    if (typeof value.method === "string" && value.method) {
        return {
            label: value.method,
            method: value.method,
            params: value.params === undefined ? [] : value.params
        };
    }
    const name = String(value.command || value.cmd || "").trim().toLowerCase();
    if (!name) {
        throw new Error("Command object needs command or method");
    }
    return fromShorthand(name, value);
}

function fromShorthand(name, extra) {
    if (name === "fan" || name === "speed" || name === "suction") {
        const speed = resolveFan(unwrapSingle(extra.speed ?? extra.fan ?? extra.value ?? extra.params));
        return { label: name, method: "set_custom_mode", params: [speed] };
    }
    if (name === "mop" || name === "water") {
        const level = resolveMop(unwrapSingle(extra.intensity ?? extra.level ?? extra.water ?? extra.value ?? extra.params));
        return { label: name, method: "set_water_box_custom_mode", params: [level] };
    }
    if (name === "rooms" || name === "segments" || name === "room" || name === "segment") {
        const segments = extra.segments || extra.rooms || extra.ids || extra.params;
        if (!Array.isArray(segments) || segments.length === 0) {
            throw new Error("Room clean needs segments: [16, 17] or names matched on the device");
        }
        const ids = segments.map((item) => {
            if (typeof item === "number") {
                return item;
            }
            if (item && typeof item === "object" && item.segmentId !== undefined) {
                return item.segmentId;
            }
            const parsed = Number(item);
            if (!Number.isFinite(parsed)) {
                throw new Error(`Unknown room segment ${item}`);
            }
            return parsed;
        });
        const repeat = Number(extra.repeat || extra.repeats || 1);
        return {
            label: name,
            method: "app_segment_clean",
            params: [{ segments: ids, repeat }]
        };
    }
    if (name === "zone" || name === "zones") {
        const zones = extra.zones || extra.params;
        if (!Array.isArray(zones)) {
            throw new Error("Zone clean needs zones: [[x1, y1, x2, y2, repeat]]");
        }
        return { label: name, method: "app_zoned_clean", params: zones };
    }
    if (name === "goto") {
        return { label: name, method: "app_goto_target", params: [Number(extra.x), Number(extra.y)] };
    }
    if (name === "map" || name === "loadmap" || name === "floor") {
        const flag = Number(extra.mapFlag ?? extra.flag ?? extra.id ?? extra.map);
        if (!Number.isFinite(flag)) {
            throw new Error("Loading a map needs mapFlag (or id) from get_multi_maps_list");
        }
        // The S7 rejects a nested array: "First element in array is not an Number".
        return { label: name, method: "load_multi_map", params: [flag] };
    }
    if (name === "maps") {
        return { label: name, method: "get_multi_maps_list", params: [] };
    }
    if (name === "map_rooms" || name === "maps_rooms") {
        throw new Error("map_rooms is handled by the vacuum node. It reads maps and rooms; it is not a single robot method.");
    }
    if (Object.prototype.hasOwnProperty.call(SHORT_COMMANDS, name)) {
        const [method, params] = SHORT_COMMANDS[name];
        return { label: name, method, params: extra.params === undefined ? params : extra.params };
    }
    if (/^[a-z0-9_]+$/.test(name)) {
        return {
            label: name,
            method: name,
            params: extra.params === undefined ? [] : extra.params
        };
    }
    throw new Error(`Unknown command "${name}"`);
}

/** CLI default: getters only. The vacuum node is not limited by this. */
function isReadOnlyMethod(method) {
    return typeof method === "string" && /^get_[a-z0-9_]+$/.test(method);
}

function assertReadOnlyCommand(spec, allowWrite) {
    if (allowWrite) {
        return spec;
    }
    if (!spec || !isReadOnlyMethod(spec.method)) {
        const method = spec && spec.method ? spec.method : "that command";
        throw new Error(`Refusing to send ${method} without --allow-write. By default the CLI only sends read-only get_* methods (get_status, get_consumable, get_multi_maps_list, get_room_mapping, and other getters).`);
    }
    return spec;
}

/** The robot wants a one-element list; accept [103] as well as 103 from the caller. */
function unwrapSingle(value) {
    return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

function resolveFan(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string") {
        const key = value.trim().toLowerCase();
        if (Object.prototype.hasOwnProperty.call(FAN_SPEEDS, key)) {
            return FAN_SPEEDS[key];
        }
        const parsed = Number(key);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    throw new Error(`Unknown fan speed. Use a number or one of: ${Object.keys(FAN_SPEEDS).join(", ")}`);
}

function resolveMop(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string") {
        const key = value.trim().toLowerCase();
        if (Object.prototype.hasOwnProperty.call(MOP_INTENSITIES, key)) {
            return MOP_INTENSITIES[key];
        }
        const parsed = Number(key);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    throw new Error(`Unknown mop level. Use a number or one of: ${Object.keys(MOP_INTENSITIES).join(", ")}`);
}

function encodeRpc({ id, method, params, timestamp }) {
    const inner = {
        id,
        method,
        params: params === undefined || params === null ? [] : params
    };
    const outer = {
        dps: { 101: JSON.stringify(inner) },
        t: timestamp
    };
    return Buffer.from(JSON.stringify(outer), "utf8");
}

function encodeRpcResponse({ id, result, error, timestamp }) {
    const inner = { id };
    if (error !== undefined) {
        inner.error = error;
    }
    if (result !== undefined) {
        inner.result = result;
    }
    const outer = {
        dps: { 102: JSON.stringify(inner) },
        t: timestamp
    };
    return Buffer.from(JSON.stringify(outer), "utf8");
}

function decodeRpcPayload(buffer) {
    let outer;
    try {
        outer = JSON.parse(Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer));
    } catch (err) {
        throw new Error("Device payload is not JSON");
    }
    const dps = outer && typeof outer === "object" ? outer.dps : null;
    if (!dps || typeof dps !== "object") {
        return { outer, dps: null, rpc: null };
    }
    const raw = dps["102"] ?? dps[102] ?? dps["101"] ?? dps[101];
    let rpc = null;
    if (typeof raw === "string") {
        try {
            rpc = JSON.parse(raw);
        } catch (_err) {
            rpc = null;
        }
    } else if (raw && typeof raw === "object") {
        rpc = raw;
    }
    return { outer, dps, rpc };
}

function rpcFailure(rpc) {
    if (!rpc || typeof rpc !== "object") {
        return null;
    }
    if (rpc.error) {
        if (typeof rpc.error === "object") {
            const code = rpc.error.code !== undefined ? ` (${rpc.error.code})` : "";
            return new Error(`${rpc.error.message || "device error"}${code}`);
        }
        return new Error(String(rpc.error));
    }
    if (rpc.result === "unknown_method") {
        return new Error("The vacuum does not recognize that method");
    }
    return null;
}

function segmentIdForName(name, rooms) {
    const text = String(name == null ? "" : name).trim();
    const lower = text.toLowerCase();
    const list = Array.isArray(rooms) ? rooms : [];
    const byName = list.find((room) => {
        return String(room.name || "").trim().toLowerCase() === lower && room.segmentId !== undefined;
    });
    if (byName) {
        return Number(byName.segmentId);
    }
    const numeric = lower.match(/^(?:room\s+)?(\d+)$/);
    if (numeric) {
        return Number(numeric[1]);
    }
    throw new Error(`No segment id for "${text}". Pass a segment id such as 16. A room name works only when it is mapped to exactly one segment.`);
}

const MAP_ROOMS_COMMANDS = new Set(["map_rooms", "maps_rooms"]);

function commandName(payload) {
    if (typeof payload === "string") {
        return payload.trim().toLowerCase();
    }
    if (payload && typeof payload === "object" && !Array.isArray(payload) && typeof payload.method !== "string") {
        return String(payload.command || payload.cmd || "").trim().toLowerCase();
    }
    return "";
}

function isMapRoomsCommand(payload) {
    return MAP_ROOMS_COMMANDS.has(commandName(payload));
}

function fanName(value) {
    return FAN_NAMES[value] || null;
}

module.exports = {
    SHORT_COMMANDS,
    resolveCommand,
    segmentIdForName,
    isMapRoomsCommand,
    isReadOnlyMethod,
    assertReadOnlyCommand,
    resolveFan,
    resolveMop,
    encodeRpc,
    encodeRpcResponse,
    decodeRpcPayload,
    rpcFailure,
    fanName
};
