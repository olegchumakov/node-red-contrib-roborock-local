"use strict";

const { loadFloor, FloorError } = require("../lib/floor");
const { loadCloudRooms } = require("../lib/admin");
const { userDirFrom } = require("../lib/map-cache");
const helpers = require("../lib/node-helpers");

module.exports = function (RED) {
    function RoborockMapsNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const device = RED.nodes.getNode(config.device);

        helpers.openSession(node, device);

        helpers.onInput(node, async (msg, send) => {
            const body = msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload) ? msg.payload : {};
            const action = String(firstSet(msg.action, body.action, config.action) || "read").toLowerCase();
            let catalog;
            let status;
            if (action === "read") {
                ({ catalog, status } = await helpers.catalogForDevice(RED, node, device));
            } else if (action === "load") {
                const mapFlag = Number(firstSet(msg.mapFlag, body.mapFlag, config.mapFlag));
                if (!Number.isFinite(mapFlag)) {
                    throw new Error("Loading a floor needs a map flag. Set it on the node or send msg.mapFlag.");
                }
                try {
                    ({ catalog, status } = await loadFloor({
                        request: (method, params) => node.session.client.request(method, params),
                        mapFlag,
                        cloudRooms: await loadCloudRooms(RED, device && device.account),
                        userDir: userDirFrom(RED),
                        duid: device && device.duid
                    }));
                } catch (err) {
                    throw err instanceof FloorError ? new Error(err.message) : err;
                }
            } else {
                throw new Error(`Unknown action "${action}". Use read or load.`);
            }
            if (status) {
                helpers.showStatus(node, status);
            }
            send(helpers.reply(RED, msg, {
                payload: catalog,
                command: action === "load" ? "map" : "map_rooms",
                status: status || null,
                device: helpers.deviceSummary(device)
            }));
        });

        helpers.onClose(node);
    }

    RED.nodes.registerType("roborock-maps", RoborockMapsNode);
};

function firstSet(...values) {
    return values.find((value) => value !== undefined && value !== null && value !== "");
}
