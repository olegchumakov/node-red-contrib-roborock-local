"use strict";

const { isCleaning, normalizeStatus } = require("./status");
const { currentMapFlag, readMapCatalogCached } = require("./maps");

class FloorError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.name = "FloorError";
        this.statusCode = statusCode || 400;
    }
}

async function waitForLoadedMap(request, mapFlag) {
    let seen = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const status = normalizeStatus(await request("get_status", []));
        seen = status && status.mapStatus !== null && status.mapStatus !== undefined
            ? currentMapFlag(status.mapStatus)
            : null;
        if (seen === mapFlag || seen === null) {
            return seen;
        }
        if (attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    }
    return seen;
}

/**
 * Load another floor and read its rooms into the cache.
 * A floor that is already loaded is only re-read: load_multi_map is not sent, and that works
 * while the robot is cleaning. Any other floor is refused while the robot is cleaning.
 */
async function loadFloor({ request, mapFlag, cloudRooms, userDir, duid }) {
    const flag = Number(mapFlag);
    if (!Number.isFinite(flag)) {
        throw new FloorError("mapFlag is required to load a map", 400);
    }
    const before = await readMapCatalogCached({ request, cloudRooms, userDir, duid });
    if (before.catalog.currentMapFlag === flag) {
        before.catalog.previousMapFlag = flag;
        before.catalog.loadedMapFlag = flag;
        before.catalog.alreadyLoaded = true;
        return { catalog: before.catalog, status: before.status, switched: false, alreadyLoaded: true };
    }
    if (isCleaning(before.status)) {
        const name = before.status && before.status.stateName ? before.status.stateName : "cleaning";
        throw new FloorError(`The robot is cleaning (${name}). Wait until it is idle, paused, or docked before loading another map.`, 409);
    }
    const previousMapFlag = before.catalog.currentMapFlag;
    await request("load_multi_map", [flag]);
    const seenFlag = await waitForLoadedMap(request, flag);
    const switched = seenFlag === flag || seenFlag === null;
    const after = await readMapCatalogCached({
        request,
        cloudRooms,
        userDir,
        duid,
        currentMapFlag: switched ? flag : undefined
    });
    const catalog = after.catalog;
    catalog.previousMapFlag = previousMapFlag;
    catalog.loadedMapFlag = flag;
    if (!switched) {
        catalog.mapSwitchUnconfirmed = true;
    }
    return { catalog, status: after.status, switched, alreadyLoaded: false };
}

module.exports = {
    FloorError,
    waitForLoadedMap,
    loadFloor
};
