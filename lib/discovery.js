"use strict";

const dgram = require("dgram");
const { DISCOVERY_PORT } = require("./constants");
const { decodeBroadcast } = require("./frame");

/**
 * Listen for vacuum UDP announcements. Roborock broadcasts on UDP 58866;
 * this does not transmit anything. Another integration (Home Assistant)
 * may already own the port — in that case enter the IP by hand.
 */
function discover(options = {}) {
    const port = options.port || DISCOVERY_PORT;
    const timeoutMs = options.timeoutMs === undefined ? 5000 : options.timeoutMs;
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const found = new Map();

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (err, value) => {
            if (settled) {
                return;
            }
            settled = true;
            try {
                socket.close();
            } catch (_err) {
                /* already closed */
            }
            if (err) {
                reject(err);
            } else {
                resolve(value);
            }
        };
        const timer = setTimeout(() => finish(null, [...found.values()]), timeoutMs);

        socket.on("error", (err) => {
            clearTimeout(timer);
            if (err.code === "EADDRINUSE") {
                finish(new Error("UDP 58866 is already in use. Enter the vacuum IP manually, or stop the other listener and try again."));
                return;
            }
            finish(err);
        });
        socket.on("message", (msg) => {
            try {
                const device = decodeBroadcast(msg);
                if (device && device.duid) {
                    found.set(device.duid, device);
                }
            } catch (_err) {
                /* ignore unrelated LAN broadcasts */
            }
        });
        socket.bind(port, () => {
            try {
                socket.setBroadcast(true);
            } catch (_err) {
                /* not fatal */
            }
        });
    });
}

function mergeDiscovery(devices, announcements) {
    const byDuid = new Map((announcements || []).map((item) => [item.duid, item]));
    return (devices || []).map((device) => {
        const found = byDuid.get(device.duid);
        return {
            ...device,
            ip: (found && found.ip) || device.ip || null,
            discoveredVersion: found ? found.version : null
        };
    });
}

module.exports = { discover, mergeDiscovery };
