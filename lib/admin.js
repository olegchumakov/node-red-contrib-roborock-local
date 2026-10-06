"use strict";

const { CloudClient, CloudError, joinRooms } = require("./cloud");
const { discover, mergeDiscovery } = require("./discovery");
const { RoborockClient } = require("./client");

const registered = new WeakSet();
const sendCodeTimes = new Map();

function registerAdmin(RED) {
    if (registered.has(RED)) {
        return;
    }
    registered.add(RED);

    const guard = RED.auth.needsPermission("flows.write");
    RED.httpAdmin.post("/roborock-local/send-code", guard, asyncRoute(sendCode));
    RED.httpAdmin.post("/roborock-local/login", guard, asyncRoute(login));
    RED.httpAdmin.post("/roborock-local/devices", guard, asyncRoute((req, res) => loadDevices(RED, req, res)));
    RED.httpAdmin.post("/roborock-local/discover", guard, asyncRoute(discoverDevices));
    RED.httpAdmin.post("/roborock-local/map-rooms", guard, asyncRoute((req, res) => mapRooms(RED, req, res)));
}

async function sendCode(req, res) {
    const body = req.body || {};
    const email = String(body.email || "").trim();
    if (!email) {
        throw new CloudError("Email is required");
    }
    enforceSendCodeLimit(email);
    const client = clientFromBody(body);
    const result = await client.sendCode();
    res.json({
        ok: true,
        channel: result.channel,
        baseUrl: result.baseUrl,
        country: client.country,
        countryCode: client.countryCode,
        clientId: result.clientId,
        message: "Verification code sent. Check your email."
    });
}

async function login(req, res) {
    const body = req.body || {};
    const client = clientFromBody(body);
    let session;
    if (body.code) {
        session = await client.loginWithCode(body.code);
    } else if (body.password) {
        session = await client.loginWithPassword(body.password);
    } else {
        throw new CloudError("Enter the emailed code or your password");
    }
    client.userData = session.userData;
    const devices = await safeDevices(client);
    res.json({
        ok: true,
        userData: session.userData,
        baseUrl: session.baseUrl,
        country: session.country,
        countryCode: session.countryCode,
        clientId: session.clientId,
        devices: devices.devices,
        rooms: devices.rooms,
        message: devices.error
            ? `Signed in, but device list failed: ${devices.error}`
            : `Signed in. ${devices.devices.length} device(s) found.`
    });
}

async function loadDevices(RED, req, res) {
    const body = req.body || {};
    const source = resolveSession(RED, body);
    const client = new CloudClient({
        email: source.email,
        clientId: source.clientId,
        region: source.region,
        baseUrl: source.baseUrl,
        userData: source.userData
    });
    const home = await client.getDevices();
    let announcements = [];
    let discoveryError = null;
    if (body.discover !== false) {
        try {
            announcements = await discover({ timeoutMs: Number(body.discoverTimeoutMs) || 4000 });
        } catch (err) {
            discoveryError = err.message;
        }
    }
    res.json({
        ok: true,
        rooms: home.rooms,
        devices: mergeDiscovery(home.devices, announcements),
        discovered: announcements,
        discoveryError
    });
}

async function discoverDevices(req, res) {
    const body = req.body || {};
    const devices = await discover({ timeoutMs: Number(body.timeoutMs) || 5000 });
    res.json({ ok: true, devices });
}

async function mapRooms(RED, req, res) {
    const body = req.body || {};
    const creds = credentialsFrom(RED, body.nodeId);
    const ip = String(body.ip || (creds && creds.ip) || "").trim();
    const localKey = body.localKey && body.localKey !== "__PWRD__"
        ? String(body.localKey)
        : (creds && creds.localKey);
    const duid = body.duid || (creds && creds.duid) || "";
    if (!ip || !localKey) {
        throw new CloudError("IP and local key are required to read the room map");
    }
    if (/[\s/]/.test(ip) || ip.includes("://")) {
        throw new CloudError("IP must be a host or address, not a URL");
    }
    const client = new RoborockClient({
        host: ip,
        localKey,
        duid,
        protocol: body.protocol || "auto",
        pingIntervalMs: 0,
        helloTimeoutMs: 4000,
        requestTimeoutMs: 8000
    });
    try {
        const mapping = await client.request("get_room_mapping", []);
        const rooms = joinRooms(mapping, body.rooms || []);
        res.json({ ok: true, mapping, rooms });
    } finally {
        client.close();
    }
}

function clientFromBody(body) {
    return new CloudClient({
        email: String(body.email || "").trim(),
        clientId: body.clientId || undefined,
        region: body.region || "auto",
        baseUrl: body.baseUrl || null
    });
}

function resolveSession(RED, body) {
    if (body.userData && body.userData !== "__PWRD__") {
        return {
            email: body.email,
            clientId: body.clientId,
            region: body.region,
            baseUrl: body.baseUrl,
            userData: parseUserData(body.userData)
        };
    }
    const creds = credentialsFrom(RED, body.nodeId);
    if (!creds || !creds.userData) {
        throw new CloudError("Sign in first. If this account was just created, deploy it, then fetch devices.", { statusCode: 401 });
    }
    const node = RED.nodes.getNode(body.nodeId);
    return {
        email: creds.email || (node && node.email) || body.email,
        clientId: creds.clientId || body.clientId,
        region: (node && node.region) || body.region || "auto",
        baseUrl: (node && node.baseUrl) || body.baseUrl || null,
        userData: parseUserData(creds.userData)
    };
}

function credentialsFrom(RED, nodeId) {
    if (!nodeId) {
        return null;
    }
    const node = RED.nodes.getNode(nodeId);
    if (!node) {
        throw new CloudError("That config node is not deployed yet. Deploy, then try again.", { statusCode: 404 });
    }
    return node.credentials || null;
}

function parseUserData(raw) {
    if (!raw) {
        return null;
    }
    if (typeof raw === "object") {
        return raw;
    }
    try {
        return JSON.parse(raw);
    } catch (_err) {
        throw new CloudError("Saved login session is unreadable. Sign in again.");
    }
}

async function safeDevices(client) {
    try {
        const home = await client.getDevices();
        let announcements = [];
        try {
            announcements = await discover({ timeoutMs: 3000 });
        } catch (_err) {
            announcements = [];
        }
        return { devices: mergeDiscovery(home.devices, announcements), rooms: home.rooms, error: null };
    } catch (err) {
        return { devices: [], rooms: [], error: err.message };
    }
}

function enforceSendCodeLimit(email) {
    const now = Date.now();
    const recent = (sendCodeTimes.get(email) || []).filter((stamp) => now - stamp < 10 * 60 * 1000);
    if (recent.length >= 3) {
        throw new CloudError("Already requested a code three times in the last 10 minutes. Wait before trying again.", { statusCode: 429 });
    }
    recent.push(now);
    sendCodeTimes.set(email, recent);
}

function asyncRoute(handler) {
    return (req, res) => {
        Promise.resolve(handler(req, res)).catch((err) => {
            const status = err.statusCode || 500;
            res.status(status).json({ ok: false, error: err.message || "Request failed", code: err.code });
        });
    };
}

module.exports = { registerAdmin };
