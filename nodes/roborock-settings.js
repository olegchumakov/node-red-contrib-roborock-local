"use strict";

const { resolveFan, resolveMop } = require("../lib/commands");
const helpers = require("../lib/node-helpers");

module.exports = function (RED) {
    function RoborockSettingsNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const device = RED.nodes.getNode(config.device);

        helpers.openSession(node, device, { RED });

        helpers.onInput(node, async (msg, send) => {
            const body = msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload) ? msg.payload : {};
            const fan = firstSet(msg.fan, body.fan, config.fan);
            const mop = firstSet(msg.mop, body.mop, config.mop);
            if (fan === undefined && mop === undefined) {
                throw new Error("Nothing to set. Choose a fan speed or a mop level, or send msg.fan / msg.mop.");
            }
            const fanValue = fan === undefined ? undefined : resolveFan(fan);
            const mopValue = mop === undefined ? undefined : resolveMop(mop);
            const payload = {};
            const methods = [];
            if (fanValue !== undefined) {
                payload.fan = await node.session.client.request("set_custom_mode", [fanValue]);
                methods.push("set_custom_mode");
            }
            if (mopValue !== undefined) {
                payload.mop = await node.session.client.request("set_water_box_custom_mode", [mopValue]);
                methods.push("set_water_box_custom_mode");
            }
            send(helpers.reply(RED, msg, {
                payload,
                method: methods.join(","),
                applied: { fan: fanValue, mop: mopValue },
                status: node.session.client.lastStatus || null,
                device: helpers.deviceSummary(device)
            }));
        });

        helpers.onClose(node);
    }

    RED.nodes.registerType("roborock-settings", RoborockSettingsNode);
};

function firstSet(...values) {
    return values.find((value) => value !== undefined && value !== null && value !== "");
}
