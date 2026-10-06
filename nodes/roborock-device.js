"use strict";

const { registerAdmin } = require("../lib/admin");

const legacySessionHints = new Set();

module.exports = function (RED) {
    registerAdmin(RED);

    function RoborockDeviceNode(config) {
        RED.nodes.createNode(this, config);
        this.deviceName = config.deviceName || "";
        this.protocol = config.protocol || "auto";
        this.firmware = config.firmware || "";
        this.pv = config.pv || "";
        this.rooms = parseRooms(config.rooms);
        this.port = Number(config.port) > 0 ? Number(config.port) : undefined;
        this.helloTimeoutMs = Number(config.helloTimeoutMs) > 0 ? Number(config.helloTimeoutMs) : undefined;
        this.requestTimeoutMs = Number(config.requestTimeoutMs) > 0 ? Number(config.requestTimeoutMs) : undefined;
        this.pingIntervalMs = config.pingIntervalMs === undefined || config.pingIntervalMs === ""
            ? undefined
            : Number(config.pingIntervalMs);
        const creds = this.credentials || {};
        this.ip = creds.ip || "";
        this.duid = creds.duid || "";
        this.localKey = creds.localKey || "";
        this.model = creds.model || "";
        this.account = config.account;
        hintLegacySession(this);
    }

    RED.nodes.registerType("roborock-device", RoborockDeviceNode, {
        credentials: {
            ip: { type: "text" },
            duid: { type: "text" },
            localKey: { type: "password" },
            model: { type: "text" }
        }
    });
};

module.exports.resetLegacySessionHintsForTests = function () {
    legacySessionHints.clear();
};

function hintLegacySession(node) {
    const creds = node.credentials || {};
    const leftover = Boolean(creds.userData || creds.email || creds.clientId);
    if (!leftover || legacySessionHints.has(node.id)) {
        return;
    }
    legacySessionHints.add(node.id);
    node.warn("Cloud login saved on this device node is ignored. Local control still uses the IP, DUID, and local key stored here. Sign in on a roborock account node, select it, and use Fetch devices from account.");
}

function parseRooms(value) {
    if (Array.isArray(value)) {
        return value;
    }
    if (!value) {
        return [];
    }
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_err) {
        return [];
    }
}
