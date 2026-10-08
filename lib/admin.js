"use strict";

const { CloudClient, CloudError, parseImportedSession } = require("./cloud");
const { discover, mergeDiscovery } = require("./discovery");
const { RoborockClient } = require("./client");
const { readMapCatalogCached } = require("./maps");
const { loadFloor, FloorError } = require("./floor");
const { userDirFrom } = require("./map-cache");
const {
    rememberEditorSession,
    readEditorSession,
    clearEditorSessions
} = require("./editor-sessions");

const registered = new WeakSet();
const sessionClearHooked = new WeakSet();
const sendCodeTimes = new Map();
let devicesLoader = null;
let homeLoader = null;

const SIGN_IN_FIRST = "Sign in on the roborock account node first. Click Done on the account, then Fetch devices. Deploy is not required before the fetch.";

function registerAdmin(RED) {
    if (registered.has(RED)) {
        return;
    }
    registered.add(RED);
    if (RED.events && typeof RED.events.on === "function" && !sessionClearHooked.has(RED.events)) {
        // The test helper builds a new RED around one emitter. Hook that emitter once.
        sessionClearHooked.add(RED.events);
        RED.events.on("flows:started", () => {
            clearEditorSessions();
        });
    }

    const guard = RED.auth.needsPermission("flows.write");
    RED.httpAdmin.post("/roborock-local/send-code", guard, asyncRoute(sendCode));
    RED.httpAdmin.post("/roborock-local/login", guard, asyncRoute(login));
    RED.httpAdmin.post("/roborock-local/devices", guard, asyncRoute((req, res) => loadDevices(RED, req, res)));
    RED.httpAdmin.post("/roborock-local/discover", guard, asyncRoute(discoverDevices));
    RED.httpAdmin.post("/roborock-local/map-rooms", guard, asyncRoute((req, res) => mapRooms(RED, req, res)));
    RED.httpAdmin.post("/roborock-local/import-session", guard, asyncRoute(importSession));
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
    rememberAccountSession(body, {
        email: client.email,
        clientId: session.clientId,
        region: body.region,
        baseUrl: session.baseUrl,
        userData: session.userData
    });
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
    let home;
    let announcements = [];
    let discoveryError = null;
    if (devicesLoader) {
        home = await devicesLoader(source);
    } else {
        const client = new CloudClient({
            email: source.email,
            clientId: source.clientId,
            region: source.region,
            baseUrl: source.baseUrl,
            userData: source.userData
        });
        home = await client.getDevices();
        if (body.discover !== false) {
            try {
                announcements = await discover({ timeoutMs: Number(body.discoverTimeoutMs) || 4000 });
            } catch (err) {
                discoveryError = err.message;
            }
        }
    }
    res.json({
        ok: true,
        rooms: home.rooms || [],
        devices: devicesLoader ? (home.devices || []) : mergeDiscovery(home.devices, announcements),
        discovered: announcements,
        discoveryError
    });
}

async function discoverDevices(req, res) {
    const body = req.body || {};
    const devices = await discover({ timeoutMs: Number(body.timeoutMs) || 5000 });
    res.json({ ok: true, devices });
}

async function importSession(req, res) {
    const body = req.body || {};
    const parsed = parseImportedSession(body.userData !== undefined ? body.userData : body.session);
    const client = new CloudClient({
        email: String(body.email || parsed.email || "").trim(),
        clientId: body.clientId || undefined,
        region: body.region || "auto",
        baseUrl: body.baseUrl || parsed.baseUrl || null,
        userData: parsed.userData,
        country: parsed.country,
        countryCode: parsed.countryCode
    });
    const home = await client.getDevices();
    rememberAccountSession(body, {
        email: client.email || parsed.email || "",
        clientId: body.clientId,
        region: body.region,
        baseUrl: client.baseUrl || parsed.baseUrl || null,
        userData: parsed.userData
    });
    res.json({
        ok: true,
        userData: parsed.userData,
        baseUrl: client.baseUrl || parsed.baseUrl || null,
        email: client.email || parsed.email || "",
        country: parsed.country,
        countryCode: parsed.countryCode,
        devices: home.devices,
        rooms: home.rooms,
        message: `Imported session. ${home.devices.length} device(s) found. Deploy to store it in credentials.`
    });
}

async function mapRooms(RED, req, res) {
    const body = req.body || {};
    const action = body.action || "read";
    const switching = action === "load" || action === "restore";
    if (switching && body.confirmed !== true) {
        throw new CloudError("Loading a map changes the robot's active floor. Confirm in the editor before sending this.", { statusCode: 400 });
    }
    if (!switching && action !== "read" && action !== "reload") {
        throw new CloudError("Unknown map action", { statusCode: 400 });
    }
    const node = body.nodeId ? RED.nodes.getNode(body.nodeId) : null;
    if (body.nodeId && !node) {
        throw new CloudError("That config node is not deployed yet. Deploy, then try again.", { statusCode: 404 });
    }
    const creds = node ? (node.credentials || null) : null;
    const ip = String(body.ip || (creds && creds.ip) || "").trim();
    const localKey = body.localKey && body.localKey !== "__PWRD__"
        ? String(body.localKey)
        : (creds && creds.localKey);
    const duid = String(body.duid || (creds && creds.duid) || "").trim();
    if (!ip || !localKey) {
        throw new CloudError("IP and local key are required to read the room map");
    }
    if (/[\s/]/.test(ip) || ip.includes("://")) {
        throw new CloudError("IP must be a host or address, not a URL");
    }
    const mapFlag = Number(body.mapFlag);
    if (switching && !Number.isFinite(mapFlag)) {
        throw new CloudError("mapFlag is required to load a map", { statusCode: 400 });
    }
    const client = new RoborockClient({
        host: ip,
        localKey,
        duid,
        port: node && node.port ? node.port : undefined,
        protocol: body.protocol || (node && node.protocol) || "auto",
        knownProtocol: body.pv || body.knownProtocol || (node && node.pv) || "",
        pingIntervalMs: 0,
        helloTimeoutMs: (node && node.helloTimeoutMs) || 4000,
        requestTimeoutMs: (node && node.requestTimeoutMs) || 8000
    });
    try {
        const accountId = body.accountId || (node && node.account) || "";
        const cloudRooms = await loadCloudRooms(RED, accountId);
        const request = (method, params) => client.request(method, params);
        const userDir = userDirFrom(RED);
        if (!switching) {
            const { catalog } = await readMapCatalogCached({ request, cloudRooms, userDir, duid });
            res.json({ ok: true, ...catalog });
            return;
        }
        let loadedFloor;
        try {
            loadedFloor = await loadFloor({ request, mapFlag, cloudRooms, userDir, duid });
        } catch (err) {
            if (err instanceof FloorError) {
                throw new CloudError(err.message, { statusCode: err.statusCode });
            }
            throw err;
        }
        const catalog = loadedFloor.catalog;
        res.json({ ok: true, ...catalog });
    } finally {
        client.close();
    }
}

/**
 * Cloud home rooms (id -> name) from the account session cache or saved credentials.
 * Failure, or no account, returns []. Callers must not invent names from this list;
 * a name is shown only when get_room_mapping links a segment to one of these ids.
 */
async function loadCloudRooms(RED, accountId) {
    if (!accountId) {
        return [];
    }
    try {
        if (homeLoader) {
            const home = await homeLoader(accountId);
            return Array.isArray(home && home.rooms) ? home.rooms : [];
        }
        const source = resolveSession(RED, { nodeId: accountId });
        const client = new CloudClient({
            email: source.email,
            clientId: source.clientId,
            region: source.region,
            baseUrl: source.baseUrl,
            userData: source.userData
        });
        const home = await client.getDevices();
        return home.rooms || [];
    } catch (_err) {
        return [];
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

function rememberAccountSession(body, session) {
    if (!body || !body.nodeId) {
        return;
    }
    rememberEditorSession(body.nodeId, session);
}

function resolveSession(RED, body) {
    const pending = pendingUserData(body.userData);
    if (pending) {
        return {
            email: body.email,
            clientId: body.clientId,
            region: body.region || "auto",
            baseUrl: body.baseUrl || null,
            userData: pending
        };
    }
    const cached = body.nodeId ? readEditorSession(body.nodeId) : null;
    if (cached) {
        return {
            email: body.email || cached.email,
            clientId: body.clientId || cached.clientId,
            region: body.region || cached.region || "auto",
            baseUrl: body.baseUrl || cached.baseUrl || null,
            userData: cached.userData
        };
    }
    if (body.nodeId) {
        let creds = null;
        let node = null;
        try {
            creds = credentialsFrom(RED, body.nodeId);
            node = RED.nodes.getNode(body.nodeId);
        } catch (err) {
            if (!err || err.statusCode !== 404) {
                throw err;
            }
        }
        if (creds && creds.userData) {
            return {
                email: creds.email || (node && node.email) || body.email,
                clientId: creds.clientId || body.clientId,
                region: (node && node.region) || body.region || "auto",
                baseUrl: (node && node.baseUrl) || body.baseUrl || null,
                userData: parseUserData(creds.userData)
            };
        }
    }
    throw new CloudError(SIGN_IN_FIRST, { statusCode: 401 });
}

function pendingUserData(raw) {
    if (raw == null || raw === "" || raw === "__PWRD__") {
        return null;
    }
    return parseUserData(raw);
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

function setDevicesLoaderForTests(loader) {
    devicesLoader = loader;
}

function setHomeLoaderForTests(loader) {
    homeLoader = loader;
}

module.exports = {
    registerAdmin,
    loadCloudRooms,
    setDevicesLoaderForTests,
    setHomeLoaderForTests,
    clearEditorSessions
};
