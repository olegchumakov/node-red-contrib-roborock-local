"use strict";

const { resolveCommand } = require("./commands");

/** The plain actions the roborock-command node accepts. Anything else belongs in roborock-vacuum. */
const ACTIONS = ["start", "resume", "pause", "stop", "dock", "home", "charge", "return", "find", "locate", "spot"];

function resolveAction(value) {
    const name = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
    if (!ACTIONS.includes(name)) {
        throw new Error(`Unknown action "${name}". Use one of: ${ACTIONS.join(", ")}. For anything else use the roborock-vacuum node.`);
    }
    return resolveCommand(name);
}

module.exports = {
    ACTIONS,
    resolveAction
};
