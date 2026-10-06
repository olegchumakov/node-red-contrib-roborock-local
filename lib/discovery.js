"use strict";

const dgram = require("dgram");
const { DISCOVERY_PORT } = require("./constants");
const { decodeBroadcast } = require("./frame");

/**
 * Listen for vacuum UDP announcements. Roborock broadcasts on UDP 58866;
 * this does not transmit anything. Another integration (Home Assistant)
 * may already own the port — in that case enter the IP by hand.
 */
function addressInUseError(port) {
    return new Error(
        `UDP ${port} is already in use (EADDRINUSE). Another program on this machine, often Home Assistant's Roborock integration, is listening for the same broadcasts. Discovery works when that integration is not running on this host. Type the vacuum IP instead, or stop the other listener and try again.`
    );
}

function discover(options = {}) {
    const port = options.port || DISCOVERY_PORT;
    const timeoutMs = options.timeoutMs === undefined ? 5000 : options.timeoutMs;
    const reuseAddr = options.reuseAddr !== false;
    const socket = dgram.createSocket({ type: "udp4", reuseAddr });
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
                finish(addressInUseError(port));
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
        const bindArgs = options.address ? { port, address: options.address } : port;
        socket.bind(bindArgs, () => {
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

module.exports = { discover, mergeDiscovery, addressInUseError };
