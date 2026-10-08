"use strict";

const { resolveAction } = require("../lib/actions");
const helpers = require("../lib/node-helpers");

module.exports = function (RED) {
    function RoborockCommandNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const device = RED.nodes.getNode(config.device);
        node.action = config.action || "start";

        helpers.openSession(node, device);

        helpers.onInput(node, async (msg, send) => {
            const override = typeof msg.payload === "string" && msg.payload.trim() ? msg.payload : null;
            const spec = resolveAction(override || node.action);
            const result = await node.session.client.request(spec.method, spec.params);
            send(helpers.reply(RED, msg, {
                payload: result,
                command: spec.label,
                method: spec.method,
                status: node.session.client.lastStatus || null,
                device: helpers.deviceSummary(device)
            }));
        });

        helpers.onClose(node);
    }

    RED.nodes.registerType("roborock-command", RoborockCommandNode);
};
