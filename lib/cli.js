"use strict";

const { RoborockClient } = require("./client");
const { resolveCommand } = require("./commands");
const { CloudClient } = require("./cloud");
const { discover } = require("./discovery");

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

async function localMain(argv) {
    const args = parseArgs(argv);
    if (args.help || args.h) {
        console.log(`Usage: roborock-local-test --ip <addr> --key <local_key> [--duid <id>] [--command get_status] [--protocol auto|1.0|L01] [--pv 1.0]

Talks to a vacuum on TCP 58867 and prints the command result. Nothing is sent to the cloud.
Run this on a machine that can reach the robot, not from CI.`);
        return 0;
    }
    if (!args.ip || !args.key) {
        console.error("Both --ip and --key are required. Optional: --duid, --command, --protocol, --timeout");
        return 1;
    }
    const commandName = args.command || "get_status";
    const spec = resolveCommand(commandName);
    const client = new RoborockClient({
        host: args.ip,
        localKey: args.key,
        duid: args.duid || "",
        protocol: args.protocol || "auto",
        knownProtocol: args.pv || "",
        requestTimeoutMs: Number(args.timeout || 8000),
        helloTimeoutMs: Number(args.helloTimeout || 4000),
        pingIntervalMs: 0,
        log: (level, message) => {
            if (level === "warn") {
                console.error(message);
            }
        }
    });
    try {
        const result = await client.request(spec.method, spec.params);
        console.log(JSON.stringify({
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
        console.error(err.message);
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

module.exports = { parseArgs, localMain, cloudMain };
