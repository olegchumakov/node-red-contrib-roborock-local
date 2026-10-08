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
        let readsInFlight = 0;

        /**
         * Events come from the change between two samples, not from a reply to one message,
         * so they never carry an incoming message. The status output does: an on-demand read
         * answers the message that asked, and its topic and other properties pass through.
         */
        function sample(status, msg, force) {
            const events = detectEvents(node.previous, status, { lowBattery: node.lowBattery });
            node.previous = status;
            const summary = helpers.deviceSummary(device);
            const emitStatus = force || (readsInFlight === 0 && helpers.shouldEmitStatus(node, status));
            const eventMessages = events.map((event) => ({
                payload: event,
                event,
                kind: "event",
                status,
                device: summary
            }));
            let statusMessage = null;
            if (emitStatus) {
                node.lastSent = status;
                statusMessage = helpers.reply(RED, msg, { payload: status, kind: "status", device: summary });
            }
            if (statusMessage || eventMessages.length) {
                node.send([statusMessage, eventMessages.length ? eventMessages : null]);
            }
        }

        helpers.openSession(node, device, {
            RED,
            pollSeconds: config.pollInterval,
            onStatus: (status) => sample(status, null, false)
        });

        helpers.onInput(node, async (msg) => {
            readsInFlight += 1;
            try {
                await node.session.client.request("get_status", []);
            } finally {
                readsInFlight -= 1;
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
