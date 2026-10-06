"use strict";

/** How long a sign-in from an open account dialog can be fetched before deploy. */
const EDITOR_SESSION_TTL_MS = 15 * 60 * 1000;

const sessions = new Map();

function rememberEditorSession(nodeId, session, options = {}) {
    const id = String(nodeId || "").trim();
    if (!id || !session || session.userData == null || session.userData === "") {
        return false;
    }
    let userData = session.userData;
    if (typeof userData === "string") {
        try {
            userData = JSON.parse(userData);
        } catch (_err) {
            return false;
        }
    }
    if (!userData || typeof userData !== "object") {
        return false;
    }
    const now = options.now || Date.now();
    const ttl = options.ttlMs == null ? EDITOR_SESSION_TTL_MS : options.ttlMs;
    sessions.set(id, {
        expires: now + ttl,
        email: session.email || "",
        clientId: session.clientId || "",
        region: session.region || "auto",
        baseUrl: session.baseUrl || null,
        userData
    });
    return true;
}

function readEditorSession(nodeId, now = Date.now()) {
    const id = String(nodeId || "").trim();
    if (!id) {
        return null;
    }
    const row = sessions.get(id);
    if (!row) {
        return null;
    }
    if (row.expires <= now) {
        sessions.delete(id);
        return null;
    }
    return row;
}

function clearEditorSessions() {
    sessions.clear();
}

module.exports = {
    EDITOR_SESSION_TTL_MS,
    rememberEditorSession,
    readEditorSession,
    clearEditorSessions
};
