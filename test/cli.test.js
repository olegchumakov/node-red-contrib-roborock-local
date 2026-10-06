"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const {
    planCliKey,
    applyStdinKey,
    localMain,
    KEY_HISTORY_WARNING,
    KEY_IGNORED_WARNING
} = require("../lib/cli");

const SECRET = "super-secret-local-key";

function capture() {
    const lines = [];
    return {
        lines,
        warn(text) {
            lines.push(String(text));
        },
        write(text) {
            lines.push(String(text));
        }
    };
}

describe("local CLI key and command guard", () => {
    test("ROBOROCK_LOCAL_KEY wins over --key and the warning does not echo the key", () => {
        const plan = planCliKey({ key: "from-flag" }, { ROBOROCK_LOCAL_KEY: SECRET }, true);
        assert.equal(plan.key, SECRET);
        assert.equal(plan.source, "env");
        assert.deepEqual(plan.warnings, [KEY_IGNORED_WARNING]);
        assert.equal(plan.warnings.join("\n").includes(SECRET), false);
        assert.equal(plan.warnings.join("\n").includes("from-flag"), false);
    });

    test("--key on a terminal warns about shell history", () => {
        const plan = planCliKey({ key: SECRET }, {}, true);
        assert.equal(plan.key, SECRET);
        assert.equal(plan.source, "flag");
        assert.deepEqual(plan.warnings, [KEY_HISTORY_WARNING]);
        assert.equal(KEY_HISTORY_WARNING.includes(SECRET), false);
    });

    test("non-TTY stdin uses the first line and ignores a later line", () => {
        const plan = applyStdinKey(
            planCliKey({}, {}, false),
            `${SECRET}\nnot-the-key\n`
        );
        assert.equal(plan.key, SECRET);
        assert.equal(plan.source, "stdin");
        assert.deepEqual(plan.warnings, []);
    });

    test("empty stdin falls back to --key with the history warning", () => {
        const plan = applyStdinKey(
            planCliKey({ key: SECRET }, {}, false),
            "\n"
        );
        assert.equal(plan.key, SECRET);
        assert.equal(plan.source, "flag");
        assert.deepEqual(plan.warnings, [KEY_HISTORY_WARNING]);
    });

    test("start without --allow-write exits before opening a socket", async () => {
        const io = capture();
        const code = await localMain([
            "--ip", "127.0.0.1",
            "--command", "start",
            "--port", "1"
        ], {
            env: { ROBOROCK_LOCAL_KEY: SECRET },
            isTTY: true,
            ...io
        });
        assert.equal(code, 1);
        const text = io.lines.join("\n");
        assert.match(text, /--allow-write/);
        assert.match(text, /app_start|start/);
        assert.equal(text.includes(SECRET), false);
    });

    test("--key warning is printed and the key is not", async () => {
        const io = capture();
        const code = await localMain([
            "--ip", "127.0.0.1",
            "--key", SECRET,
            "--command", "app_start"
        ], { env: {}, isTTY: true, ...io });
        assert.equal(code, 1);
        const text = io.lines.join("\n");
        assert.match(text, /shell history/);
        assert.match(text, /--allow-write/);
        assert.equal(text.includes(SECRET), false);
    });

    test("help documents the env var and does not require --key", async () => {
        const io = capture();
        const code = await localMain(["--help"], { ...io, env: {}, isTTY: true });
        assert.equal(code, 0);
        const text = io.lines.join("\n");
        assert.match(text, /ROBOROCK_LOCAL_KEY/);
        assert.match(text, /--allow-write/);
        assert.equal(/--key <local_key>/.test(text), false);
        assert.equal(text.includes("Both --ip and --key are required"), false);
    });

    test("--allow-write gets past the guard and then fails to connect", async () => {
        const server = net.createServer();
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = server.address().port;
        await new Promise((resolve) => server.close(resolve));
        const io = capture();
        const code = await localMain([
            "--ip", "127.0.0.1",
            "--port", String(port),
            "--command", "start",
            "--allow-write",
            "--pv", "1.0",
            "--helloTimeout", "200"
        ], {
            env: { ROBOROCK_LOCAL_KEY: SECRET },
            isTTY: false,
            stdinText: "",
            ...io
        });
        assert.equal(code, 1);
        const text = io.lines.join("\n");
        assert.equal(/without --allow-write/.test(text), false);
        assert.match(text, /ECONNREFUSED|EACCES|connect/i);
        assert.equal(text.includes(SECRET), false);
    });
});
