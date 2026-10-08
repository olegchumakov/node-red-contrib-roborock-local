"use strict";

const { resolveCommand, isMapRoomsCommand } = require("../lib/commands");
const { normalizeStatus } = require("../lib/status");
const { resolveRoomTargets, isPlainSegmentLabel } = require("../lib/maps");
const helpers = require("../lib/node-helpers");

/**
 * The universal node: any shorthand, any raw {method, params}. Use it for commands the
 * dedicated nodes do not cover, including ones this package does not document.
 */
module.exports = function (RED) {
    function RoborockVacuumNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const device = RED.nodes.getNode(config.device);
        node.statusOnChange = config.statusOnChange !== false;
        node.command = config.command || "";
        node.lastSent = null;

        helpers.openSession(node, device, {
            pollSeconds: config.pollInterval,
            onStatus: (status) => {
                if (helpers.shouldEmitStatus(node, status)) {
                    node.lastSent = status;
                    node.send([null, {
                        payload: status,
                        topic: "status",
                        device: helpers.deviceSummary(device)
                    }]);
                }
            }
        });

        helpers.onInput(node, async (msg, send) => {
            const incoming = msg.payload === undefined || msg.payload === null || msg.payload === ""
                ? node.command
                : msg.payload;
            let out;
            if (isMapRoomsCommand(incoming)) {
                const { catalog, status } = await helpers.catalogForDevice(RED, node, device);
                if (status) {
                    helpers.showStatus(node, status);
                }
                out = helpers.reply(RED, msg, {
                    payload: catalog,
                    command: "map_rooms",
                    method: "map_rooms",
                    status: status || null,
                    device: helpers.deviceSummary(device)
                });
            } else {
                const spec = await resolveVacuumCommand(incoming, node, device, RED);
                const result = await node.session.client.request(spec.method, spec.params);
                const status = spec.method === "get_status" ? normalizeStatus(result) : node.session.client.lastStatus;
                if (status) {
                    helpers.showStatus(node, status);
                }
                out = helpers.reply(RED, msg, {
                    payload: result,
                    command: spec.label,
                    method: spec.method,
                    status: status || null,
                    device: helpers.deviceSummary(device)
                });
            }
            send([out, null]);
        });

        helpers.onClose(node);
    }

    RED.nodes.registerType("roborock-vacuum", RoborockVacuumNode);
};

async function resolveVacuumCommand(payload, node, device, RED) {
    const named = await withNamedRooms(payload, node, device, RED);
    return resolveCommand(named, node.command);
}

async function withNamedRooms(payload, node, device, RED) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.method) {
        return payload;
    }
    const command = String(payload.command || payload.cmd || "").trim().toLowerCase();
    const isRooms = command === "rooms" || command === "segments" || command === "room" || command === "segment";
    if (!isRooms) {
        return payload;
    }
    if (payload.segments || payload.rooms || payload.ids || payload.params) {
        return payload;
    }
    let names = payload.names;
    if (!Array.isArray(names) && payload.name != null && payload.name !== "") {
        names = [payload.name];
    }
    if (!Array.isArray(names) || names.length === 0) {
        return payload;
    }
    let catalog = null;
    if (names.some((name) => !isPlainSegmentLabel(name))) {
        const read = await helpers.catalogForDevice(RED, node, device);
        catalog = read.catalog;
        if (read.status) {
            helpers.showStatus(node, read.status);
        }
    }
    const ids = resolveRoomTargets(names, catalog);
    return { ...payload, segments: ids };
}
