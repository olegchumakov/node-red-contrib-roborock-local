"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const CACHE_FILE = "roborock-local-map-cache.json";

let writeChain = Promise.resolve();

function userDirFrom(RED) {
    const configured = RED && RED.settings && RED.settings.userDir;
    return configured ? String(configured) : path.join(os.tmpdir(), "node-red-roborock");
}

function cacheFilePath(userDir) {
    return path.join(userDir || path.join(os.tmpdir(), "node-red-roborock"), CACHE_FILE);
}

function emptyStore() {
    return { version: 1, devices: {} };
}

function readStore(userDir) {
    const file = cacheFilePath(userDir);
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!parsed || typeof parsed !== "object" || !parsed.devices || typeof parsed.devices !== "object") {
            return emptyStore();
        }
        return { version: 1, devices: parsed.devices };
    } catch (err) {
        if (err && err.code === "ENOENT") {
            return emptyStore();
        }
        return emptyStore();
    }
}

function writeStore(userDir, store) {
    const file = cacheFilePath(userDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

function enqueue(work) {
    const run = writeChain.then(work, work);
    writeChain = run.then(() => undefined, () => undefined);
    return run;
}

function deviceKey(duid) {
    const key = String(duid || "").trim();
    return key || "";
}

function readDeviceCache(userDir, duid) {
    const key = deviceKey(duid);
    if (!key) {
        return {};
    }
    const store = readStore(userDir);
    const device = store.devices[key];
    return device && typeof device === "object" ? device : {};
}

function rememberLoadedRooms(userDir, duid, catalog) {
    const key = deviceKey(duid);
    if (!key || !catalog) {
        return Promise.resolve(false);
    }
    const current = (catalog.maps || []).find((map) => map.current);
    if (!current || !Number.isFinite(Number(current.mapFlag))) {
        return Promise.resolve(false);
    }
    // A failed fresh read must not overwrite a good cache with an empty list.
    if (catalog.mappingError && current.cached) {
        return Promise.resolve(false);
    }
    if (catalog.mappingError && (!current.segments || current.segments.length === 0)) {
        return Promise.resolve(false);
    }
    const entry = {
        mapFlag: Number(current.mapFlag),
        name: current.name || "",
        segments: (current.segments || []).map((segment) => {
            const copy = { segmentId: segment.segmentId };
            if (segment.name) {
                copy.name = segment.name;
            }
            return copy;
        }),
        cachedAt: new Date().toISOString()
    };
    return enqueue(() => {
        const store = readStore(userDir);
        const device = store.devices[key] && typeof store.devices[key] === "object"
            ? store.devices[key]
            : {};
        device[String(entry.mapFlag)] = entry;
        store.devices[key] = device;
        writeStore(userDir, store);
        return true;
    });
}

function resetMapCacheForTests() {
    writeChain = Promise.resolve();
}

module.exports = {
    CACHE_FILE,
    userDirFrom,
    cacheFilePath,
    readDeviceCache,
    rememberLoadedRooms,
    resetMapCacheForTests
};
