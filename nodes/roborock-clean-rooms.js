"use strict";

const { resolveCommand, resolveFan, resolveMop } = require("../lib/commands");
const { resolveRoomTargets, isPlainSegmentLabel } = require("../lib/maps");
const { loadFloor, FloorError } = require("../lib/floor");
const { loadCloudRooms } = require("../lib/admin");
const { userDirFrom } = require("../lib/map-cache");
const helpers = require("../lib/node-helpers");

module.exports = function (RED) {
    function RoborockCleanRoomsNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const device = RED.nodes.getNode(config.device);

        helpers.openSession(node, device, { RED });

        helpers.onInput(node, async (msg, send) => {
            const sources = [msg, payloadSource(msg.payload), config];
            const target = pickTargets(sources);
            if (!target.segments.length && !target.names.length) {
                throw new Error("No rooms to clean. Pick rooms on the node, or send msg.segments / msg.names.");
            }
            const mapFlag = firstSet(...sources.map((source) => source.mapFlag));
            const repeat = parseRepeat(firstSet(...sources.map((source) => source.repeat)));
            const fan = firstSet(...sources.map((source) => source.fan));
            const mop = firstSet(...sources.map((source) => source.mop));
            const fanValue = fan === undefined ? undefined : resolveFan(fan);
            const mopValue = mop === undefined ? undefined : resolveMop(mop);
            const request = (method, params) => node.session.client.request(method, params);

            let catalog = null;
            let switched = false;
            if (mapFlag !== undefined) {
                const flag = Number(mapFlag);
                if (!Number.isFinite(flag)) {
                    throw new Error(`Map flag "${mapFlag}" is not a number`);
                }
                catalog = (await helpers.catalogForDevice(RED, node, device)).catalog;
                if (catalog.currentMapFlag === null) {
                    node.warn(`The robot did not report which floor is loaded, so map ${flag} was not loaded. Cleaning the loaded floor.`);
                } else if (catalog.currentMapFlag !== flag) {
                    let loaded;
                    try {
                        loaded = await loadFloor({
                            request,
                            mapFlag: flag,
                            cloudRooms: await loadCloudRooms(RED, device && device.account),
                            userDir: userDirFrom(RED),
                            duid: device && device.duid
                        });
                    } catch (err) {
                        throw err instanceof FloorError ? new Error(err.message) : err;
                    }
                    if (loaded.catalog.mapSwitchUnconfirmed) {
                        throw new Error(`The robot did not switch to map ${flag}, so nothing was cleaned.`);
                    }
                    catalog = loaded.catalog;
                    switched = true;
                }
            }

            const segments = [...target.segments];
            if (target.names.length) {
                if (!catalog && target.names.some((name) => !isPlainSegmentLabel(name))) {
                    catalog = (await helpers.catalogForDevice(RED, node, device)).catalog;
                }
                segments.push(...resolveRoomTargets(target.names, catalog));
            }
            const unique = [...new Set(segments)];

            if (fanValue !== undefined) {
                await request("set_custom_mode", [fanValue]);
            }
            if (mopValue !== undefined) {
                await request("set_water_box_custom_mode", [mopValue]);
            }
            const spec = resolveCommand({ command: "rooms", segments: unique, repeat });
            const result = await request(spec.method, spec.params);
            send(helpers.reply(RED, msg, {
                payload: result,
                command: "rooms",
                method: spec.method,
                segments: unique,
                repeat,
                floorSwitched: switched,
                status: node.session.client.lastStatus || null,
                device: helpers.deviceSummary(device)
            }));
        });

        helpers.onClose(node);
    }

    RED.nodes.registerType("roborock-clean-rooms", RoborockCleanRoomsNode);
};

function plainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * msg.payload names rooms only when it says so: an array (numbers are segment ids, text is
 * room names) or an object with segments / rooms / names. A number, string, boolean, or
 * a default inject timestamp is ignored, so it can never replace the rooms set on the node.
 */
function payloadSource(payload) {
    if (Array.isArray(payload)) {
        return { segments: payload.filter(isNumeric), names: payload.filter((item) => !isNumeric(item)) };
    }
    return plainObject(payload) ? payload : {};
}

function isNumeric(value) {
    return (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && /^\s*\d+\s*$/.test(value));
}

function toList(value) {
    if (value === undefined || value === null || value === "") {
        return [];
    }
    if (Array.isArray(value)) {
        return value.map((item) => (typeof item === "string" ? item.trim() : item)).filter((item) => item !== "");
    }
    if (typeof value === "string") {
        return value.split(",").map((item) => item.trim()).filter(Boolean);
    }
    return [value];
}

function pickTargets(sources) {
    for (const source of sources) {
        const segments = toList(source.segments !== undefined ? source.segments : source.rooms).map((item) => {
            const id = Number(item);
            if (!Number.isInteger(id) || id < 0) {
                throw new Error(`Room segment "${item}" is not a valid id`);
            }
            return id;
        });
        const names = toList(source.names);
        if (segments.length || names.length) {
            return { segments, names };
        }
    }
    return { segments: [], names: [] };
}

function parseRepeat(value) {
    if (value === undefined) {
        return 1;
    }
    const repeat = Number(value);
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3) {
        throw new Error("Repeat must be 1, 2, or 3");
    }
    return repeat;
}

function firstSet(...values) {
    return values.find((value) => value !== undefined && value !== null && value !== "");
}
