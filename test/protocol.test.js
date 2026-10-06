"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { crc32 } = require("../lib/crc32");
const { encodeTimestamp, v1Key, encryptPayload, decryptPayload } = require("../lib/crypto");
const {
    encodeConnect,
    encodePythonHello,
    encodeDataFrame,
    FrameDecoder,
    decodeBroadcast,
    decryptFrame
} = require("../lib/frame");
const { encodeRpc, decodeRpcPayload, resolveCommand } = require("../lib/commands");
const { normalizeStatus, stateName, errorName } = require("../lib/status");

const LOCAL_KEY = "testlocalkey1234";
const V1_PAYLOAD = Buffer.from(
    '{"dps":{"101":"{\\"id\\":20001,\\"method\\":\\"get_status\\",\\"params\\":[]}"},"t":1700000000}',
    "utf8"
);
const V1_FRAME = "00000077312e30000186a1000056ce6553f1000004006096bf00b8df2184015e262240ef994ba283c45da7cbd6c4a9dac93458a66b3834d8a27b82ed4da9df1c0132920701cde3a2a6f66693f802e890b265cd85a509e7389729f19424a878480ac138d7451b808a4168e430a8b8c75368c91c2b9ad03fe1b34d11";
const L01_PAYLOAD = Buffer.from(
    '{"dps":{"101":"{\\"id\\":1806,\\"method\\":\\"get_prop\\",\\"params\\":[\\"get_status\\"]}"},"t":1753606905}',
    "utf8"
);
const L01_CIPHER = "fd60c8daca1ccae67f6077477bfa9d37189a38d75b3c4a907c2435d3c146ee84d8f99597e3e1571a015961ceaa4d64bc3695fae024c3416737d77150341de29cad2f95bfaf532358f12bbff89f140fef5b1ee284c3abfe3b83a577910a72056dab4d5a75b182d1a0cba145e3e450f3927443";
const L01_FRAME = "000000894c3031000000010004a47b6885eaf900040072" + L01_CIPHER + "c3f91f90";
const V1_BROADCAST = "312e30000003e003e80040b87035058b439f36af42f249605f8661897173f111bb849a6231831f5874a0cf220a25872ea412d796b4902ee57fdc120074b901b482acb1fe6d06317e3a72ddac654fe0";
const L01_BROADCAST = "4c30310000000000000043841496d5a31e34b5b02c1867c445509ba5a21aec1fa4b307bddeb27a75d9b366193e8a97d0534dc39851c980609f2670cdcaee04594ec5c93e3c5ae609b0c9a203139ac8e40c8c";

describe("protocol vectors from python-roborock", () => {
    test("crc32 matches the common check value", () => {
        assert.equal(crc32(Buffer.from("123456789")), 0xCBF43926);
    });

    test("timestamp scramble and v1 key", () => {
        assert.equal(encodeTimestamp(1700000000).toString(), "1030556f");
        assert.equal(v1Key(LOCAL_KEY, 1700000000).toString("hex"), "a8a7d743e5df1f5e9f10d92c07febe09");
    });

    test("v1 publish frame matches MessageParser.build", () => {
        const frame = encodeDataFrame({
            version: "1.0",
            seq: 100001,
            random: 22222,
            timestamp: 1700000000,
            protocol: 4,
            payload: V1_PAYLOAD,
            localKey: LOCAL_KEY
        });
        assert.equal(frame.toString("hex"), V1_FRAME);
    });

    test("v1 frame round-trips through the stream decoder", () => {
        const decoder = new FrameDecoder();
        const garbage = Buffer.from([0x00, 0x11]);
        const frame = Buffer.from(V1_FRAME, "hex");
        const part = frame.subarray(0, 10);
        assert.equal(decoder.push(Buffer.concat([garbage, part])).length, 0);
        const frames = decoder.push(frame.subarray(10));
        assert.equal(frames.length, 1);
        const splitPlain = decryptFrame(frames[0], { localKey: LOCAL_KEY });
        assert.equal(splitPlain.toString(), V1_PAYLOAD.toString());
        decoder.clear();
        const oneByte = new FrameDecoder();
        const whole = Buffer.concat([garbage, frame]);
        let decoded = [];
        for (const byte of whole) {
            decoded = decoded.concat(oneByte.push(Buffer.from([byte])));
        }
        assert.equal(decoded.length, 1);
        const plain = decryptFrame(decoded[0], { localKey: LOCAL_KEY });
        assert.equal(plain.toString(), V1_PAYLOAD.toString());
        const rpc = decodeRpcPayload(plain);
        assert.equal(rpc.rpc.method, "get_status");
        assert.equal(rpc.rpc.id, 20001);
    });

    test("l01 gcm ciphertext and full frame", () => {
        const encrypted = encryptPayload(L01_PAYLOAD, {
            version: "L01",
            localKey: "b8Hj5mFk3QzT7rLp",
            timestamp: 1753606905,
            sequence: 1,
            nonce: 304251,
            connectNonce: 893563,
            ackNonce: 485592656
        });
        assert.equal(encrypted.toString("hex"), L01_CIPHER);
        const plain = decryptPayload(encrypted, {
            version: "L01",
            localKey: "b8Hj5mFk3QzT7rLp",
            timestamp: 1753606905,
            sequence: 1,
            nonce: 304251,
            connectNonce: 893563,
            ackNonce: 485592656
        });
        assert.equal(plain.toString(), L01_PAYLOAD.toString());
        const frame = encodeDataFrame({
            version: "L01",
            seq: 1,
            random: 304251,
            timestamp: 1753606905,
            protocol: 4,
            payload: L01_PAYLOAD,
            localKey: "b8Hj5mFk3QzT7rLp",
            connectNonce: 893563,
            ackNonce: 485592656
        });
        assert.equal(frame.toString("hex"), L01_FRAME);
    });

    test("app connect and python hello layouts", () => {
        assert.equal(
            encodeConnect({ version: "1.0", connectNonce: 12345, keepAlive: 10 }).toString("hex"),
            "00000015312e3000000000000030390000000000000000000a"
        );
        assert.equal(
            encodePythonHello({
                version: "1.0",
                seq: 1,
                random: 12345,
                timestamp: 1700000000
            }).toString("hex"),
            "00000015312e3000000001000030396553f1000000ec498b72"
        );
    });

    test("discovery packets from python-roborock", () => {
        const v1 = decodeBroadcast(Buffer.from(V1_BROADCAST, "hex"));
        assert.equal(v1.duid, "h96rOV3e8DTPMAOLiypREl");
        assert.equal(v1.ip, "192.168.20.250");
        assert.equal(v1.version, "1.0");
        const l01 = decodeBroadcast(Buffer.from(L01_BROADCAST, "hex"));
        assert.equal(l01.duid, "ZrQn1jfZtJQLoPOL7620e");
        assert.equal(l01.ip, "192.168.1.4");
        assert.equal(l01.version, "L01");
    });
});

describe("commands and status", () => {
    test("encodeRpc matches the python payload bytes", () => {
        const encoded = encodeRpc({
            id: 20001,
            method: "get_status",
            params: [],
            timestamp: 1700000000
        });
        assert.equal(encoded.toString(), V1_PAYLOAD.toString());
    });

    test("shorthand and raw commands", () => {
        assert.deepEqual(resolveCommand("dock"), { label: "dock", method: "app_charge", params: [] });
        assert.deepEqual(resolveCommand("home"), { label: "home", method: "app_charge", params: [] });
        assert.equal(resolveCommand({ command: "fan", speed: "turbo" }).params, 103);
        assert.equal(resolveCommand({ command: "fan", speed: 38 }).params, 38);
        assert.deepEqual(resolveCommand({ command: "rooms", segments: [16, 17], repeat: 2 }).params, [
            { segments: [16, 17], repeat: 2 }
        ]);
        assert.equal(resolveCommand({ method: "get_consumable", params: [] }).method, "get_consumable");
        const loaded = resolveCommand({ command: "map", id: "0" });
        assert.deepEqual(loaded.params, [0]);
        assert.equal(typeof loaded.params[0], "number");
        assert.throws(() => resolveCommand(""), /No command/);
    });

    test("status names", () => {
        const status = normalizeStatus([{
            state: 5,
            battery: 42,
            error_code: 0,
            fan_power: 102,
            clean_area: 12500000
        }]);
        assert.equal(status.stateName, "cleaning");
        assert.equal(status.battery, 42);
        assert.equal(status.fanName, "balanced");
        assert.equal(status.cleanAreaM2, 12.5);
        assert.equal(stateName(8), "charging");
        assert.equal(stateName(6), "returning");
        assert.equal(errorName(5), "main brush jammed");
        assert.equal(normalizeStatus([{ state: 3, battery: 100 }]).stateName, "idle");
    });
});
