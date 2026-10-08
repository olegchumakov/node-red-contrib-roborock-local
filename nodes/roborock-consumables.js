"use strict";

const { normalizeConsumables, lowParts } = require("../lib/consumables");
const helpers = require("../lib/node-helpers");

module.exports = function (RED) {
    function RoborockConsumablesNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const device = RED.nodes.getNode(config.device);
        const threshold = config.threshold === "" || config.threshold === undefined ? 10 : Number(config.threshold);

        helpers.openSession(node, device, { RED });

        helpers.onInput(node, async (msg, send) => {
            const raw = await node.session.client.request("get_consumable", []);
            const consumables = normalizeConsumables(raw);
            if (!consumables) {
                throw new Error("The robot returned no consumable data");
            }
            const summary = helpers.deviceSummary(device);
            const low = lowParts(consumables, threshold);
            const result = helpers.reply(RED, msg, {
                payload: consumables,
                kind: "consumables",
                low,
                device: summary
            });
            let alert = null;
            if (threshold > 0 && low.length) {
                alert = helpers.reply(RED, msg, {
                    payload: low,
                    kind: "consumables-low",
                    consumables,
                    device: summary
                });
            }
            send([result, alert]);
        });

        helpers.onClose(node);
    }

    RED.nodes.registerType("roborock-consumables", RoborockConsumablesNode);
};
