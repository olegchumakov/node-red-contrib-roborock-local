"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const CACHE_FILE = "roborock-local-protocol-cache.json";
const VERSIONS = new Set(["1.0", "L01"]);

const inProcess = new Map();

function cacheFilePath(userDir) {
    return path.join(userDir || path.join(os.tmpdir(), "node-red-roborock"), CACHE_FILE);
}

function readStore(userDir) {
    try {
        const parsed = JSON.parse(fs.readFileSync(cacheFilePath(userDir), "utf8"));
        return parsed && typeof parsed === "object" && parsed.devices && typeof parsed.devices === "object"
            ? parsed.devices
            : {};
    } catch (_err) {
        return {};
    }
}

/**
 * Which local protocol version last worked for one device. Kept in memory for the life of
 * the process and in a small file in the Node-RED user directory, so a restart does not
 * repeat the failed hello. The file is not part of the flow and never holds the key.
 */
function protocolMemory(userDir, key) {
    const id = `${userDir || ""}|${key}`;
    return {
        get() {
            const known = inProcess.get(id) || readStore(userDir)[key];
            return VERSIONS.has(known) ? known : null;
        },
        set(version) {
            if (!VERSIONS.has(version) || inProcess.get(id) === version) {
                return;
            }
            inProcess.set(id, version);
            try {
                const devices = readStore(userDir);
                devices[key] = version;
                fs.mkdirSync(path.dirname(cacheFilePath(userDir)), { recursive: true });
                fs.writeFileSync(cacheFilePath(userDir), JSON.stringify({ version: 1, devices }, null, 2));
            } catch (_err) {
                /* The in-process copy still works for this run. */
            }
        }
    };
}

function resetProtocolMemoryForTests() {
    inProcess.clear();
}

module.exports = {
    protocolMemory,
    cacheFilePath,
    resetProtocolMemoryForTests
};
