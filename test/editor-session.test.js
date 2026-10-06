"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const {
    EDITOR_SESSION_TTL_MS,
    rememberEditorSession,
    readEditorSession,
    clearEditorSessions
} = require("../lib/editor-sessions");

describe("editor session cache", () => {
    test("a sign-in expires and a cleared cache is empty", () => {
        clearEditorSessions();
        const now = 1_700_000_000_000;
        assert.equal(rememberEditorSession("acc", {
            email: "user@example.com",
            userData: { token: "secret-token" }
        }, { now, ttlMs: EDITOR_SESSION_TTL_MS }), true);
        assert.equal(readEditorSession("acc", now + 1000).userData.token, "secret-token");
        assert.equal(readEditorSession("acc", now + EDITOR_SESSION_TTL_MS), null);
        rememberEditorSession("acc", { userData: "{\"token\":\"secret-token\"}" }, { now });
        assert.equal(readEditorSession("acc", now).email, "");
        clearEditorSessions();
        assert.equal(readEditorSession("acc", now), null);
        assert.equal(rememberEditorSession("", { userData: { token: "secret-token" } }), false);
    });
});
