"use strict";

const { RoborockClient } = require("./client");
const { resolveCommand, assertReadOnlyCommand } = require("./commands");
const { CloudClient } = require("./cloud");
const { discover } = require("./discovery");

const LOCAL_KEY_ENV = "ROBOROCK_LOCAL_KEY";
const KEY_HISTORY_WARNING = "Warning: --key puts the local key in shell history. Prefer ROBOROCK_LOCAL_KEY or the prompt.";
const KEY_IGNORED_WARNING = "Ignoring --key because ROBOROCK_LOCAL_KEY is set. --key puts the local key in shell history.";

const LOCAL_HELP = `Usage: roborock-local-test --ip <addr> [--duid <id>] [--command get_status] [--protocol auto|1.0|L01] [--pv 1.0] [--port 58867] [--allow-write]

The local key is read from the ROBOROCK_LOCAL_KEY environment variable, from the first line of stdin when stdin is not a terminal, or from a prompt. --key still works, but it stores the key in shell history and prints a warning.

By default only read-only get_* methods are sent (get_status, get_consumable, get_multi_maps_list, get_room_mapping, and other getters). Anything else, including start and load_multi_map, needs --allow-write. The Node-RED vacuum node is not limited this way.

Talks to a vacuum on TCP 58867 and prints the command result. Nothing is sent to the cloud.
Run this on a machine that can reach the robot, not from CI.`;

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith("--")) {
            out._.push(arg);
            continue;
        }
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
            out[key] = true;
        } else {
            out[key] = next;
            i += 1;
        }
    }
    return out;
}

function flagValue(value) {
    return typeof value === "string" ? value.trim() : "";
}

/**
 * Decide where the local key comes from, without reading stdin or prompting.
 * ROBOROCK_LOCAL_KEY wins. --key is only a fallback and produces a history warning.
 */
function planCliKey(args, env, isTTY) {
    const fromEnv = flagValue(env && env[LOCAL_KEY_ENV]);
    const fromFlag = flagValue(args && args.key);
    if (fromEnv) {
        return {
            key: fromEnv,
            source: "env",
            warnings: fromFlag ? [KEY_IGNORED_WARNING] : [],
            readStdin: false,
            prompt: false
        };
    }
    if (!isTTY) {
        return {
            key: "",
            source: "stdin",
            warnings: [],
            readStdin: true,
            prompt: false,
            flagFallback: fromFlag
        };
    }
    if (fromFlag) {
        return {
            key: fromFlag,
            source: "flag",
            warnings: [KEY_HISTORY_WARNING],
            readStdin: false,
            prompt: false
        };
    }
    return {
        key: "",
        source: "prompt",
        warnings: [],
        readStdin: false,
        prompt: true
    };
}

function applyStdinKey(plan, stdinText) {
    const line = String(stdinText || "").split(/\r?\n/, 1)[0].trim();
    if (line) {
        return { ...plan, key: line, source: "stdin", readStdin: false };
    }
    if (plan.flagFallback) {
        return {
            ...plan,
            key: plan.flagFallback,
            source: "flag",
            readStdin: false,
            warnings: plan.warnings.concat(KEY_HISTORY_WARNING)
        };
    }
    return { ...plan, key: "", source: "stdin", readStdin: false };
}

function readAllStdin() {
    return new Promise((resolve, reject) => {
        const chunks = [];
        process.stdin.on("data", (chunk) => chunks.push(chunk));
        process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        process.stdin.on("error", reject);
    });
}

function promptLine(question) {
    const readline = require("readline");
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        rl.question(question, (answer) => {
            rl.close();
            resolve(String(answer || "").trim());
        });
    });
}

async function resolveLocalKey(args, io = {}) {
    const env = io.env || process.env;
    const isTTY = io.isTTY !== undefined ? Boolean(io.isTTY) : Boolean(process.stdin.isTTY);
    let plan = planCliKey(args, env, isTTY);
    if (plan.readStdin) {
        const text = io.stdinText !== undefined ? io.stdinText : await readAllStdin();
        plan = applyStdinKey(plan, text);
    } else if (plan.prompt) {
        const ask = io.ask || promptLine;
        const answer = await ask("Local key: ");
        plan = { ...plan, key: String(answer || "").trim(), source: "prompt" };
    }
    return plan;
}

async function localMain(argv, io = {}) {
    const args = parseArgs(argv);
    const write = io.write || ((text) => console.log(text));
    const warn = io.warn || ((text) => console.error(text));
    if (args.help || args.h) {
        write(LOCAL_HELP);
        return 0;
    }
    const resolved = await resolveLocalKey(args, io);
    for (const message of resolved.warnings) {
        warn(message);
    }
    if (!args.ip || !resolved.key) {
        warn("IP and a local key are required. Pass --ip, and set ROBOROCK_LOCAL_KEY, pipe the key on stdin, or enter it at the prompt. Optional: --duid, --command, --protocol, --pv, --allow-write");
        return 1;
    }
    let spec;
    try {
        spec = resolveCommand(args.command || "get_status");
        assertReadOnlyCommand(spec, Boolean(args["allow-write"]));
    } catch (err) {
        warn(err.message);
        return 1;
    }
    const client = new RoborockClient({
        host: args.ip,
        port: Number(args.port) > 0 ? Number(args.port) : undefined,
        localKey: resolved.key,
        duid: args.duid || "",
        protocol: args.protocol || "auto",
        knownProtocol: args.pv || "",
        requestTimeoutMs: Number(args.timeout || 8000),
        helloTimeoutMs: Number(args.helloTimeout || 4000),
        pingIntervalMs: 0,
        log: (level, message) => {
            if (level === "warn") {
                warn(message);
            }
        }
    });
    try {
        const result = await client.request(spec.method, spec.params);
        write(JSON.stringify({
            duid: args.duid || null,
            ip: args.ip,
            protocol: client.version,
            hello: client.helloStyle,
            method: spec.method,
            result,
            status: client.lastStatus
        }, null, 2));
        return 0;
    } catch (err) {
        warn(err.message);
        return 1;
    } finally {
        client.close();
    }
}

async function cloudMain(argv) {
    const args = parseArgs(argv);
    if (args.help || args.h) {
        console.log(`Usage: roborock-cloud-login --email you@example.com [--region ru|eu|us|cn|auto] [--password ...] [--code ...]

Sends a Roborock verification code when --code and --password are omitted, then prints devices and local keys.
The keys are secrets. This is a setup helper for the author's LAN; runtime control does not call the cloud.`);
        return 0;
    }
    const readline = require("readline");
    const ask = (question) => new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
    const email = args.email || await ask("Roborock email: ");
    const region = args.region || "auto";
    const client = new CloudClient({ email, region, baseUrl: args.baseUrl || null });
    try {
        if (!args.code && !args.password) {
            const sent = await client.sendCode();
            console.error(`Code sent via ${sent.channel} (${sent.baseUrl}).`);
            args.code = await ask("Verification code: ");
        }
        const session = args.password && !args.code
            ? await client.loginWithPassword(args.password)
            : await client.loginWithCode(args.code);
        client.userData = session.userData;
        const home = await client.getDevices();
        let found = [];
        try {
            found = await discover({ timeoutMs: Number(args.discoverTimeout || 4000) });
        } catch (err) {
            console.error(`Discovery: ${err.message}`);
        }
        const byDuid = new Map(found.map((item) => [item.duid, item]));
        const devices = home.devices.map((device) => ({
            ...device,
            ip: (byDuid.get(device.duid) && byDuid.get(device.duid).ip) || null
        }));
        console.error("local_key is a device secret. It changes after a Wi-Fi reset or re-pairing.");
        if (args.json) {
            console.log(JSON.stringify({ baseUrl: session.baseUrl, country: session.country, rooms: home.rooms, devices }, null, 2));
        } else {
            for (const device of devices) {
                console.log([
                    device.name,
                    device.model,
                    device.firmware ? `fw ${device.firmware}` : "",
                    device.ip || "ip unknown",
                    device.duid,
                    device.localKey
                ].filter(Boolean).join("\t"));
            }
        }
        return 0;
    } catch (err) {
        console.error(err.message);
        return 1;
    }
}

module.exports = {
    parseArgs,
    planCliKey,
    applyStdinKey,
    resolveLocalKey,
    localMain,
    cloudMain,
    LOCAL_KEY_ENV,
    KEY_HISTORY_WARNING,
    KEY_IGNORED_WARNING
};
