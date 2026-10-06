"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const dgram = require("dgram");
const { RoborockClient } = require("../lib/client");
const { discover } = require("../lib/discovery");
const { parseImportedSession, CloudError } = require("../lib/cloud");
const { resolveCommand, segmentIdForName, assertReadOnlyCommand } = require("../lib/commands");
const {
    currentMapFlag,
    normalizeMapList,
    normalizeSegments,
    emptySegmentWarning,
    describeMaps
} = require("../lib/maps");

describe("maps and protocol selection", () => {
    test("current map flag follows map_status only for the 4n+3 pattern", () => {
        assert.equal(currentMapFlag(3), 0);
        assert.equal(currentMapFlag(7), 1);
        assert.equal(currentMapFlag(11), 2);
        assert.equal(currentMapFlag(15), 3);
        assert.equal(currentMapFlag(0), null);
        assert.equal(currentMapFlag(1), null);
        assert.equal(currentMapFlag(4), null);
        assert.equal(currentMapFlag(5), null);
        assert.equal(currentMapFlag(6), null);
        assert.equal(currentMapFlag(8), null);
        assert.equal(currentMapFlag(12), null);
        assert.equal(currentMapFlag(1.5), null);
        assert.equal(currentMapFlag(undefined), null);
        assert.equal(currentMapFlag("11"), 2);
    });

    test("map names are kept as plain UTF-8, including a literal percent sign", () => {
        const maps = normalizeMapList([{
            max_multi_map: 4,
            max_bak_map: 1,
            multi_map_count: 2,
            map_info: [
                { mapFlag: 1, add_time: 1693646551, length: 10, name: "2 этаж", bak_maps: [{ mapFlag: 5, add_time: 1682500367 }] },
                { mapFlag: 2, add_time: 1791144593, length: 10, name: "1 этаж", bak_maps: [{ mapFlag: 6, add_time: 1789666028 }] },
                { mapFlag: 3, name: "Дом%20", length: 6 }
            ]
        }]);
        assert.equal(maps[0].name, "2 этаж");
        assert.equal(maps[1].name, "1 этаж");
        assert.equal(maps[2].name, "Дом%20");
        assert.equal(currentMapFlag(11), 2);
        const segments = normalizeSegments([], 2);
        assert.deepEqual(segments, []);
        assert.match(describeMaps(maps, segments, 2), /1 этаж \(current\)/);
        assert.equal(describeMaps(maps, segments, 2).includes("Дом "), false);
    });

    test("empty mapping does not claim lab_status means missing room splits", () => {
        const warning = emptySegmentWarning({ mapName: "1 этаж" });
        assert.match(warning, /No segments returned for the current map "1 этаж"/);
        assert.match(warning, /Enter numbered segment ids by hand/);
        assert.match(warning, /load another map and read again/);
        assert.match(warning, /Cloud home room names are not used/);
        assert.equal(warning.includes("lab_status"), false);
        assert.equal(warning.includes("unsave_map_flag"), false);
        assert.equal(warning.includes("often means"), false);
        assert.equal(warning.includes("Главная спальня"), false);
    });

    test("auto with pv 1.0 skips L01, forced L01 does not", () => {
        const auto = new RoborockClient({
            host: "127.0.0.1",
            localKey: "key",
            protocol: "auto",
            knownProtocol: "1.0"
        });
        assert.deepEqual(auto.versionsToTry(), ["1.0"]);
        auto.close();
        const forced = new RoborockClient({
            host: "127.0.0.1",
            localKey: "key",
            protocol: "L01",
            knownProtocol: "1.0"
        });
        assert.deepEqual(forced.versionsToTry(), ["L01"]);
        forced.close();
        const unknown = new RoborockClient({ host: "127.0.0.1", localKey: "key", protocol: "auto" });
        assert.deepEqual(unknown.versionsToTry(), ["1.0", "L01"]);
        unknown.close();
    });

    test("segment ids and map load commands", () => {
        assert.equal(segmentIdForName("Room 16", []), 16);
        assert.equal(segmentIdForName("16", [{ segmentId: 16, name: "Room 16" }]), 16);
        assert.equal(segmentIdForName("Hall", [{ segmentId: 17, name: "Hall" }]), 17);
        assert.deepEqual(resolveCommand({ command: "map", mapFlag: 1 }), {
            label: "map",
            method: "load_multi_map",
            params: [[1]]
        });
        assert.equal(resolveCommand("maps").method, "get_multi_maps_list");
        assert.doesNotThrow(() => assertReadOnlyCommand(resolveCommand("get_status"), false));
        assert.doesNotThrow(() => assertReadOnlyCommand(resolveCommand("get_consumable"), false));
        assert.doesNotThrow(() => assertReadOnlyCommand(resolveCommand("maps"), false));
        assert.doesNotThrow(() => assertReadOnlyCommand(resolveCommand("get_room_mapping"), false));
        assert.throws(() => assertReadOnlyCommand(resolveCommand("start"), false), /--allow-write/);
        assert.doesNotThrow(() => assertReadOnlyCommand(resolveCommand("start"), true));
        assert.doesNotThrow(() => assertReadOnlyCommand(resolveCommand({ command: "map", mapFlag: 1 }), true));
    });

    test("imported Home Assistant session is accepted without echoing secrets", () => {
        const parsed = parseImportedSession(JSON.stringify({
            domain: "roborock",
            data: {
                username: "user@example.com",
                base_url: "https://ruiot.roborock.com",
                user_data: {
                    token: "session-token",
                    country: "RU",
                    countrycode: "7",
                    rriot: { u: "u", s: "s", h: "h", k: "k", r: { a: "https://api-ru.roborock.com" } }
                }
            }
        }));
        assert.equal(parsed.email, "user@example.com");
        assert.equal(parsed.baseUrl, "https://ruiot.roborock.com");
        assert.equal(parsed.country, "RU");
        assert.equal(parsed.userData.rriot.u, "u");
        assert.throws(() => parseImportedSession({ token: "super-secret-token" }), (err) => {
            assert.ok(err instanceof CloudError);
            assert.equal(err.message.includes("super-secret-token"), false);
            assert.match(err.message, /rriot/);
            return true;
        });
    });

    test("discovery reports EADDRINUSE without hanging", async () => {
        const taken = dgram.createSocket({ type: "udp4", reuseAddr: false });
        await new Promise((resolve, reject) => {
            taken.once("error", reject);
            taken.bind({ port: 0, address: "127.0.0.1" }, resolve);
        });
        const port = taken.address().port;
        try {
            await assert.rejects(
                discover({ port, address: "127.0.0.1", timeoutMs: 500, reuseAddr: false }),
                (err) => {
                    assert.match(err.message, /EADDRINUSE/);
                    assert.match(err.message, /Home Assistant/);
                    return true;
                }
            );
        } finally {
            taken.close();
        }
    });
});
