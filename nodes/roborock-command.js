"use strict";

const { resolveAction } = require("../lib/actions");
const helpers = require("../lib/node-helpers");

/**
 * Right after a pause the robot can answer a dock request with "action locked (-10003)" and
 * accept the same request a few seconds later. The dock action waits and tries once more.
 */
let dockRetryMs = 12000;
const ACTION_LOCKED = /action locked|-10003/i;

function setDockRetryMsForTests(ms) {
    dockRetryMs = ms >= 0 ? ms : 12000;
}

module.exports = function (RED) {
    function RoborockCommandNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const device = RED.nodes.getNode(config.device);
        node.action = config.action || "start";
        let retryTimer = null;
        let wake = null;

        helpers.openSession(node, device, { RED });

        function pause(ms) {
            return new Promise((resolve) => {
                wake = resolve;
                retryTimer = setTimeout(() => {
                    retryTimer = null;
                    resolve();
                }, ms);
            });
        }

        helpers.onInput(node, async (msg, send) => {
            const override = typeof msg.payload === "string" && msg.payload.trim() ? msg.payload : null;
            const spec = resolveAction(override || node.action);
            let retried = false;
            let result;
            try {
                result = await node.session.client.request(spec.method, spec.params);
            } catch (err) {
                if (spec.method !== "app_charge" || !ACTION_LOCKED.test(err.message) || !node.session) {
                    throw err;
                }
                retried = true;
                node.status({ fill: "yellow", shape: "ring", text: "dock locked, retrying" });
                await pause(dockRetryMs);
                if (!node.session) {
                    throw err;
                }
                result = await node.session.client.request(spec.method, spec.params);
            }
            const out = {
                payload: result,
                command: spec.label,
                method: spec.method,
                status: node.session.client.lastStatus || null,
                device: helpers.deviceSummary(device)
            };
            if (retried) {
                out.retried = true;
            }
            send(helpers.reply(RED, msg, out));
        });

        node.on("close", () => {
            if (retryTimer) {
                clearTimeout(retryTimer);
                retryTimer = null;
            }
            if (wake) {
                wake();
                wake = null;
            }
        });
        helpers.onClose(node);
    }

    RED.nodes.registerType("roborock-command", RoborockCommandNode);
};

module.exports.setDockRetryMsForTests = setDockRetryMsForTests;
