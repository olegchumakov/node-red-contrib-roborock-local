"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const dgram = require("dgram");
const { RoborockClient } = require("../lib/client");
const { discover } = require("../lib/discovery");
const { parseImportedSession, CloudError } = require("../lib/cloud");
const { segmentIdForName, assertReadOnlyCommand, resolveCommand, isMapRoomsCommand } = require("../lib/commands");
const {
    currentMapFlag,
    normalizeMapList,
    normalizeSegments,
    emptySegmentWarning,
    describeMaps,
    buildMapCatalog,
    resolveRoomTargets,
    ROOMS_WHEN_LOADED,
    NO_ROOM_MAPPING
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
        assert.equal(warning, NO_ROOM_MAPPING);
        assert.equal(warning.includes("lab_status"), false);
        assert.equal(warning.includes("unsave_map_flag"), false);
        assert.equal(warning.includes("often means"), false);
        assert.equal(warning.includes("Главная спальня"), false);
    });

    test("catalog keeps rooms from map_info and names only linked segments", () => {
        const maps = normalizeMapList([{
            map_info: [
                { mapFlag: 1, name: "2 этаж" },
                {
                    mapFlag: 2,
                    name: "1 этаж",
                    rooms: [
                        { id: 16, tag: 1, iot_name_id: "1", iot_name: "Спальня" },
                        { id: 17, tag: 2, iot_name_id: "2", iot_name: "Кухня" },
                        { id: 18, tag: 3, iot_name_id: "-1", iot_name: "" },
                        { id: 19, tag: 4 }
                    ]
                }
            ]
        }]);
        assert.equal(maps[0].rooms, null);
        assert.equal(maps[1].rooms.length, 4);
        const cloudRooms = [
            { id: 1, name: "Главная спальня" },
            { id: 2, name: "Гостиная" },
            { id: 99, name: "Kitchen" }
        ];
        // map_status 7 -> flag 1, so "2 этаж" is loaded. Mapping links segment 20 to cloud room 99.
        // The third tuple value is a room tag, not a map flag.
        const catalog = buildMapCatalog({
            maps,
            mapping: [[20, "99", 12]],
            currentMapFlag: 1,
            cloudRooms
        });
        assert.equal(catalog.currentMapFlag, 1);
        assert.equal(catalog.maps[0].current, true);
        assert.deepEqual(catalog.maps[0].segments, [{ segmentId: 20, name: "Kitchen" }]);
        assert.equal(catalog.maps[1].current, false);
        assert.deepEqual(catalog.maps[1].segments, [
            { segmentId: 16, name: "Спальня" },
            { segmentId: 17, name: "Кухня" },
            { segmentId: 18 },
            { segmentId: 19 }
        ]);
        const dumped = JSON.stringify(catalog);
        assert.equal(dumped.includes("Главная спальня"), false);
        assert.equal(dumped.includes("Гостиная"), false);
        assert.equal(resolveRoomTargets(["Kitchen"], catalog)[0], 20);
        assert.deepEqual(resolveRoomTargets(["Room 16", "16"], null), [16, 16]);
        assert.throws(() => resolveRoomTargets(["Главная спальня"], catalog), /No segment id/);
        assert.throws(() => resolveRoomTargets(["Спальня"], catalog), /not the loaded map/);
    });

    test("a floor without map_info rooms says they are visible once that map is loaded", () => {
        const maps = normalizeMapList([{
            map_info: [
                { mapFlag: 1, name: "2 этаж" },
                { mapFlag: 2, name: "1 этаж" }
            ]
        }]);
        const catalog = buildMapCatalog({
            maps,
            mapping: [],
            currentMapFlag: 1,
            cloudRooms: [{ id: 1, name: "Главная спальня" }]
        });
        assert.equal(catalog.maps[0].note, NO_ROOM_MAPPING);
        assert.equal(catalog.maps[1].note, ROOMS_WHEN_LOADED);
        assert.equal(JSON.stringify(catalog).includes("Главная спальня"), false);
        const segments = normalizeSegments([[16, "14731399", 12]], undefined);
        assert.equal(segments[0].segmentId, 16);
        assert.equal(segments[0].roomId, "14731399");
        assert.equal(segments[0].mapFlag, undefined);
    });

    test("map_rooms is not sent as a raw robot method", () => {
        assert.equal(isMapRoomsCommand({ command: "map_rooms" }), true);
        assert.equal(isMapRoomsCommand("maps_rooms"), true);
        assert.equal(isMapRoomsCommand({ command: "maps" }), false);
        assert.throws(() => resolveCommand({ command: "map_rooms" }), /vacuum node/);
        assert.equal(resolveCommand({ command: "maps" }).method, "get_multi_maps_list");
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
        const numeric = resolveCommand({ command: "map", mapFlag: 1 });
        assert.equal(numeric.method, "load_multi_map");
        assert.deepEqual(numeric.params, [1]);
        assert.equal(typeof numeric.params[0], "number");
        const fromString = resolveCommand({ command: "map", mapFlag: "2" });
        assert.deepEqual(fromString.params, [2]);
        assert.equal(typeof fromString.params[0], "number");
        assert.equal(Array.isArray(fromString.params[0]), false);
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
