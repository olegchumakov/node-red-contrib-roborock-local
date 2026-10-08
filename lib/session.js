"use strict";

const { RoborockClient } = require("./client");

const sessions = new Map();

function signature(options) {
    return [
        options.host,
        options.port,
        options.localKey,
        options.protocol || "auto",
        options.knownProtocol || ""
    ].join("|");
}

/**
 * One TCP session per device config node, shared by every vacuum node that uses it.
 * Release is delayed briefly so a redeploy can reattach before the socket is torn down.
 */
function acquire(id, options) {
    let session = sessions.get(id);
    const sig = signature(options);
    if (session && session.sig !== sig) {
        clearTimeout(session.closing);
        session.client.close();
        sessions.delete(id);
        session = null;
    }
    if (!session) {
        const client = new RoborockClient(options);
        // Every node on the device adds its own status, failure, disconnect and ready listeners.
        client.setMaxListeners(0);
        session = {
            id,
            sig,
            client,
            refs: 0,
            pollers: new Map(),
            closing: null
        };
        sessions.set(id, session);
        client.connect().catch(() => {
            /* Handshake failure emits "failure" and schedules a reconnect. */
        });
    }
    if (session.closing) {
        clearTimeout(session.closing);
        session.closing = null;
    }
    session.refs += 1;
    return session;
}

function release(id) {
    const session = sessions.get(id);
    if (!session) {
        return;
    }
    session.refs -= 1;
    if (session.refs <= 0) {
        session.refs = 0;
        session.closing = setTimeout(() => {
            if (session.refs <= 0 && sessions.get(id) === session) {
                session.client.close();
                sessions.delete(id);
            }
        }, 250);
        if (typeof session.closing.unref === "function") {
            session.closing.unref();
        }
    }
}

function setPoll(id, ownerId, intervalMs) {
    const session = sessions.get(id);
    if (!session) {
        return;
    }
    if (intervalMs > 0) {
        session.pollers.set(ownerId, intervalMs);
    } else {
        session.pollers.delete(ownerId);
    }
    const values = [...session.pollers.values()].filter((value) => value > 0);
    session.client.setPollInterval(values.length ? Math.min(...values) : 0);
}

/** The live session for a device, without joining it. Null when none is open. */
function peek(id) {
    return sessions.get(id) || null;
}

function resetForTests() {
    for (const session of sessions.values()) {
        clearTimeout(session.closing);
        session.client.close();
    }
    sessions.clear();
}

module.exports = {
    acquire,
    release,
    setPoll,
    peek,
    resetForTests
};
