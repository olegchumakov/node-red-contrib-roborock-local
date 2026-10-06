"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const dgram = require("dgram");
const { RoborockClient } = require("../lib/client");
const { discover } = require("../lib/discovery");
const { parseImportedSession, CloudError } = require("../lib/cloud");
const { resolveCommand, segmentIdForName } = require("../lib/commands");
const {
    currentMapFlag,
    normalizeMapList,
    normalizeSegments,
    emptySegmentWarning,
    describeMaps
} = require("../lib/maps");

describe("maps and protocol selection", () => {
    test("current map flag follows map_status", () => {
        assert.equal(currentMapFlag(3), 0);
        assert.equal(currentMapFlag(7), 1);
        assert.equal(currentMapFlag(11), 2);
        assert.equal(currentMapFlag(0), null);
        assert.equal(currentMapFlag(undefined), null);
    });

    test("map names come from get_multi_maps_list and segments are numbered", () => {
        const maps = normalizeMapList([{
            max_multi_map: 4,
            multi_map_count: 2,
            map_info: [
                { mapFlag: 0, name: "1%20%D1%8D%D1%82%D0%B0%D0%B6", length: 8 },
                { mapFlag: 1, name: "2 этаж", length: 5 }
            ]
        }]);
        assert.equal(maps[0].name, "1 этаж");
        assert.equal(maps[1].name, "2 этаж");
        const segments = normalizeSegments([[16, "13665932", 0], [17, "13665933", 0]], 0);
        assert.deepEqual(segments, [
            { segmentId: 16, name: "Room 16", mapFlag: 0 },
            { segmentId: 17, name: "Room 17", mapFlag: 0 }
        ]);
        assert.match(describeMaps(maps, segments, 0), /1 этаж \(current\)/);
        assert.match(describeMaps(maps, segments, 0), /Room 16/);
    });

    test("empty mapping names the current map and does not invent cloud room names", () => {
        const warning = emptySegmentWarning({ mapName: "1 этаж", labStatus: 3, unsaveMapFlag: 2 });
        assert.match(warning, /No segments returned for the current map "1 этаж"/);
        assert.match(warning, /lab_status 3/);
        assert.match(warning, /unsave_map_flag 2/);
        assert.match(warning, /not used/);
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
