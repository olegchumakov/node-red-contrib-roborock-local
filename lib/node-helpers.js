"use strict";

const sessionPool = require("./session");
const { statusColor, statusText, sameStatus } = require("./status");
const { readMapCatalogCached } = require("./maps");
const { loadCloudRooms } = require("./admin");
const { userDirFrom } = require("./map-cache");

let failureStatusMs = 6000;

function trimStatus(text) {
    const value = String(text || "");
    return value.length > 48 ? `${value.slice(0, 45)}...` : value;
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

/** A copy of the incoming message with the given fields set, so topic and other properties survive. */
function reply(RED, msg, fields) {
    const out = msg && typeof msg === "object" ? RED.util.cloneMessage(msg) : {};
    return Object.assign(out, fields);
}

function sessionOptions(device, log) {
    return {
        host: device.ip,
        port: device.port,
        localKey: device.localKey,
        duid: device.duid,
        protocol: device.protocol,
        knownProtocol: device.pv,
        helloTimeoutMs: device.helloTimeoutMs,
        requestTimeoutMs: device.requestTimeoutMs,
        pingIntervalMs: device.pingIntervalMs,
        log
    };
}

/**
 * Join the shared TCP session for a device and keep the node status line current.
 * Sets node.session (null when the device lacks an IP or key). Pair with closeSession.
 * options.pollSeconds > 0 asks for periodic get_status. options.onStatus gets every status sample.
 */
function openSession(node, device, options = {}) {
    node.session = null;
    node._rrDevice = device || null;
    if (!device || !device.ip || !device.localKey) {
        node.status({ fill: "red", shape: "ring", text: "set IP and local key" });
        return null;
    }
    node.status({ fill: "yellow", shape: "ring", text: "connecting" });
    node.session = sessionPool.acquire(device.id, sessionOptions(device, (level, message) => {
        if (level === "warn") {
            node.warn(message);
        } else {
            node.debug(message);
        }
    }));
    const pollSeconds = Number(options.pollSeconds) || 0;
    sessionPool.setPoll(device.id, node.id, pollSeconds > 0 ? pollSeconds * 1000 : 0);
    const client = node.session.client;
    const listeners = {
        status: (status) => {
            showStatus(node, status);
            if (options.onStatus) {
                options.onStatus(status);
            }
        },
        failure: (err) => {
            clearFailureTimer(node);
            node.status({ fill: "red", shape: "ring", text: trimStatus(err.message) });
        },
        disconnect: () => {
            clearFailureTimer(node);
            node.status({ fill: "yellow", shape: "ring", text: "reconnecting" });
        },
        ready: () => {
            node.status({ fill: "green", shape: "dot", text: "connected" });
        }
    };
    for (const [event, listener] of Object.entries(listeners)) {
        client.on(event, listener);
    }
    node._rrListeners = listeners;
    return node.session;
}

function closeSession(node) {
    clearFailureTimer(node);
    const device = node._rrDevice;
    if (node.session && node._rrListeners) {
        for (const [event, listener] of Object.entries(node._rrListeners)) {
            node.session.client.removeListener(event, listener);
        }
    }
    node._rrListeners = null;
    if (device && node.session) {
        sessionPool.setPoll(device.id, node.id, 0);
        sessionPool.release(device.id);
    }
    node.session = null;
}

function showStatus(node, status) {
    clearFailureTimer(node);
    node.status({
        fill: statusColor(status.state),
        shape: "dot",
        text: trimStatus(statusText(status))
    });
}

/**
 * Show a command failure on the status line, then fall back to the last known robot state
 * so one failed command does not leave the node red until the next poll.
 */
function showFailure(node, err) {
    clearFailureTimer(node);
    node.status({ fill: "red", shape: "ring", text: trimStatus(err && err.message) });
    node._rrFailureTimer = setTimeout(() => {
        node._rrFailureTimer = null;
        const last = node.session && node.session.client.lastStatus;
        if (last) {
            showStatus(node, last);
        } else if (node.session && node.session.client.ready) {
            node.status({ fill: "green", shape: "dot", text: "connected" });
        }
    }, failureStatusMs);
    if (typeof node._rrFailureTimer.unref === "function") {
        node._rrFailureTimer.unref();
    }
}

function clearFailureTimer(node) {
    if (node._rrFailureTimer) {
        clearTimeout(node._rrFailureTimer);
        node._rrFailureTimer = null;
    }
}

/**
 * Wrap an async input handler: report a missing device, report failures on the status line,
 * and always call done. work(msg, send) returns the message(s) to send, or nothing.
 */
function onInput(node, work) {
    node.on("input", (msg, send, done) => {
        const complete = done || function (err) {
            if (err) {
                node.error(err, msg);
            }
        };
        const emit = send || ((out) => node.send(out));
        if (!node.session) {
            complete(new Error("Roborock device is missing an IP or local key"));
            return;
        }
        Promise.resolve().then(() => work(msg, emit)).then(() => {
            complete();
        }).catch((err) => {
            showFailure(node, err);
            complete(err);
        });
    });
}

function onClose(node) {
    node.on("close", function (removed, done) {
        if (typeof removed === "function") {
            done = removed;
        }
        closeSession(node);
        done();
    });
}

function shouldEmitStatus(node, status) {
    if (node.statusOnChange === false) {
        return true;
    }
    return !sameStatus(node.lastSent, status);
}

async function catalogForDevice(RED, node, device) {
    const cloudRooms = await loadCloudRooms(RED, device && device.account);
    return readMapCatalogCached({
        request: (method, params) => node.session.client.request(method, params),
        cloudRooms,
        userDir: userDirFrom(RED),
        duid: device && device.duid
    });
}

function setFailureStatusMsForTests(ms) {
    failureStatusMs = ms > 0 ? ms : 6000;
}

module.exports = {
    setFailureStatusMsForTests,
    trimStatus,
    deviceSummary,
    reply,
    openSession,
    closeSession,
    showStatus,
    showFailure,
    onInput,
    onClose,
    shouldEmitStatus,
    catalogForDevice
};
