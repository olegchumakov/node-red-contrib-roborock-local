"use strict";

const sessionPool = require("../lib/session");
const { resolveCommand, isMapRoomsCommand } = require("../lib/commands");
const { statusColor, statusText, sameStatus, normalizeStatus } = require("../lib/status");
const { readMapCatalogCached, resolveRoomTargets, isPlainSegmentLabel } = require("../lib/maps");
const { loadCloudRooms } = require("../lib/admin");
const { userDirFrom } = require("../lib/map-cache");

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
            const incoming = msg.payload === undefined || msg.payload === null || msg.payload === ""
                ? node.command
                : msg.payload;
            Promise.resolve().then(async () => {
                if (isMapRoomsCommand(incoming)) {
                    return readMapRooms(node, device, RED);
                }
                const spec = await resolveVacuumCommand(incoming, node, device, RED);
                const result = await node.session.client.request(spec.method, spec.params);
                const status = spec.method === "get_status" ? normalizeStatus(result) : node.session.client.lastStatus;
                if (status) {
                    publishStatus(node, device, status, true);
                }
                return {
                    payload: result,
                    command: spec.label,
                    method: spec.method,
                    status: status || null,
                    device: deviceSummary(device)
                };
            }).then((out) => {
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

async function readMapRooms(node, device, RED) {
    const { catalog, status } = await catalogForDevice(node, device, RED);
    if (status) {
        publishStatus(node, device, status, true);
    }
    return {
        payload: catalog,
        command: "map_rooms",
        method: "map_rooms",
        status: status || null,
        device: deviceSummary(device)
    };
}

async function catalogForDevice(node, device, RED) {
    const cloudRooms = await loadCloudRooms(RED, device && device.account);
    return readMapCatalogCached({
        request: (method, params) => node.session.client.request(method, params),
        cloudRooms,
        userDir: userDirFrom(RED),
        duid: device && device.duid
    });
}

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
        const read = await catalogForDevice(node, device, RED);
        catalog = read.catalog;
        if (read.status) {
            publishStatus(node, device, read.status, true);
        }
    }
    const ids = resolveRoomTargets(names, catalog);
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
