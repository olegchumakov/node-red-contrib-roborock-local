"use strict";

const { detectEvents } = require("../lib/events");
const helpers = require("../lib/node-helpers");

module.exports = function (RED) {
    function RoborockStatusNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const device = RED.nodes.getNode(config.device);
        node.statusOnChange = config.statusOnChange !== false;
        node.lowBattery = Number(config.lowBattery) || 0;
        node.lastSent = null;
        node.previous = null;
        let refreshing = false;

        function sample(status, msg, force) {
            const events = detectEvents(node.previous, status, { lowBattery: node.lowBattery });
            node.previous = status;
            const summary = helpers.deviceSummary(device);
            const emitStatus = force || (!refreshing && helpers.shouldEmitStatus(node, status));
            const eventMessages = events.map((event) => helpers.reply(RED, msg, {
                payload: event,
                topic: "event",
                status,
                device: summary
            }));
            let statusMessage = null;
            if (emitStatus) {
                node.lastSent = status;
                statusMessage = helpers.reply(RED, msg, { payload: status, topic: "status", device: summary });
            }
            if (statusMessage || eventMessages.length) {
                node.send([statusMessage, eventMessages.length ? eventMessages : null]);
            }
        }

        helpers.openSession(node, device, {
            pollSeconds: config.pollInterval,
            onStatus: (status) => sample(status, null, false)
        });

        helpers.onInput(node, async (msg) => {
            refreshing = true;
            try {
                await node.session.client.request("get_status", []);
            } finally {
                refreshing = false;
            }
            const status = node.session.client.lastStatus;
            if (!status) {
                throw new Error("The robot returned no status");
            }
            sample(status, msg, true);
        });

        helpers.onClose(node);
    }

    RED.nodes.registerType("roborock-status", RoborockStatusNode);
};
