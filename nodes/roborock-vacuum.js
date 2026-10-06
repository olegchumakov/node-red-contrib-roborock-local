"use strict";

const sessionPool = require("../lib/session");
const { resolveCommand, segmentIdForName } = require("../lib/commands");
const { statusColor, statusText, sameStatus, normalizeStatus } = require("../lib/status");

module.exports = function (RED) {
    function RoborockVacuumNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const device = RED.nodes.getNode(config.device);
        node.statusOnChange = config.statusOnChange !== false;
        node.command = config.command || "";
        node.lastSent = null;
        node.session = null;

        if (!device || !device.ip || !device.localKey) {
            node.status({ fill: "red", shape: "ring", text: "set IP and local key" });
        } else {
            node.status({ fill: "yellow", shape: "ring", text: "connecting" });
            node.session = sessionPool.acquire(device.id, {
                host: device.ip,
                port: device.port,
                localKey: device.localKey,
                duid: device.duid,
                protocol: device.protocol,
                knownProtocol: device.pv,
                helloTimeoutMs: device.helloTimeoutMs,
                requestTimeoutMs: device.requestTimeoutMs,
                pingIntervalMs: device.pingIntervalMs,
                log: (level, message) => {
                    if (level === "warn") {
                        node.warn(message);
                    } else {
                        node.debug(message);
                    }
                }
            });
            const pollSeconds = Number(config.pollInterval) || 0;
            sessionPool.setPoll(device.id, node.id, pollSeconds > 0 ? pollSeconds * 1000 : 0);
            node._onStatus = (status) => publishStatus(node, device, status, false);
            node._onFailure = (err) => {
                node.status({ fill: "red", shape: "ring", text: trimStatus(err.message) });
            };
            node._onDisconnect = () => {
                node.status({ fill: "yellow", shape: "ring", text: "reconnecting" });
            };
            node._onReady = () => {
                node.status({ fill: "green", shape: "dot", text: "connected" });
            };
            node.session.client.on("status", node._onStatus);
            node.session.client.on("failure", node._onFailure);
            node.session.client.on("disconnect", node._onDisconnect);
            node.session.client.on("ready", node._onReady);
        }

        node.on("input", (msg, send, done) => {
            const complete = done || function (err) {
                if (err) {
                    node.error(err, msg);
                }
            };
            if (!node.session) {
                complete(new Error("Roborock device is missing an IP or local key"));
                return;
            }
            let spec;
            try {
                const payload = withNamedRooms(msg.payload, device);
                spec = resolveCommand(payload, node.command);
            } catch (err) {
                node.status({ fill: "red", shape: "ring", text: trimStatus(err.message) });
                complete(err);
                return;
            }
            node.session.client.request(spec.method, spec.params).then((result) => {
                const status = spec.method === "get_status" ? normalizeStatus(result) : node.session.client.lastStatus;
                if (status) {
                    publishStatus(node, device, status, true);
                }
                const out = {
                    payload: result,
                    command: spec.label,
                    method: spec.method,
                    status: status || null,
                    device: deviceSummary(device)
                };
                send([out, null]);
                complete();
            }).catch((err) => {
                node.status({ fill: "red", shape: "ring", text: trimStatus(err.message) });
                complete(err);
            });
        });

        node.on("close", function (removed, done) {
            if (typeof removed === "function") {
                done = removed;
            }
            detach(node);
            if (device) {
                sessionPool.setPoll(device.id, node.id, 0);
                sessionPool.release(device.id);
            }
            done();
        });
    }

    RED.nodes.registerType("roborock-vacuum", RoborockVacuumNode);
};

function publishStatus(node, device, status, fromCommand) {
    node.status({
        fill: statusColor(status.state),
        shape: "dot",
        text: trimStatus(statusText(status))
    });
    if (fromCommand || !node.statusOnChange || !sameStatus(node.lastSent, status)) {
        if (!fromCommand) {
            node.lastSent = status;
            node.send([null, {
                payload: status,
                topic: "status",
                device: deviceSummary(device)
            }]);
        }
    }
}

function withNamedRooms(payload, device) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.names)) {
        return payload;
    }
    if (payload.segments || payload.rooms || payload.ids) {
        return payload;
    }
    const ids = payload.names.map((name) => segmentIdForName(name, device.rooms));
    return { ...payload, segments: ids };
}

function deviceSummary(device) {
    if (!device) {
        return null;
    }
    return {
        name: device.deviceName || device.name || "",
        duid: device.duid || "",
        model: device.model || "",
        ip: device.ip || ""
    };
}

function detach(node) {
    if (!node.session) {
        return;
    }
    const client = node.session.client;
    if (node._onStatus) {
        client.removeListener("status", node._onStatus);
    }
    if (node._onFailure) {
        client.removeListener("failure", node._onFailure);
    }
    if (node._onDisconnect) {
        client.removeListener("disconnect", node._onDisconnect);
    }
    if (node._onReady) {
        client.removeListener("ready", node._onReady);
    }
}

function trimStatus(text) {
    const value = String(text || "");
    return value.length > 48 ? `${value.slice(0, 45)}...` : value;
}
