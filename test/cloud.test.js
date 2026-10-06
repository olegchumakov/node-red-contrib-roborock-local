"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { CloudClient, hawkHeader, CloudError } = require("../lib/cloud");

function closeServer(server) {
    return new Promise((resolve) => {
        if (typeof server.closeAllConnections === "function") {
            server.closeAllConnections();
        }
        server.close(resolve);
    });
}

describe("cloud api", () => {
    test("hawk header matches python-roborock", () => {
        const header = hawkHeader(
            { u: "user-uid", s: "session-secret", h: "hawk-key" },
            "/user/homes/12345",
            { timestamp: 1700000000, nonce: "abc123XYZ0" }
        );
        assert.equal(
            header,
            'Hawk id="user-uid",s="session-secret",ts="1700000000",nonce="abc123XYZ0",mac="XzLQIbjzJ73Y513fAa8FjwzAyQVx9CpjugJogk5YOiY="'
        );
    });

    test("code login and home data against a fake Roborock cloud", async () => {
        const rriot = { u: "user-uid", s: "session-secret", h: "hawk-key", k: "k", r: { a: null } };
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, "http://127.0.0.1");
            const chunks = [];
            req.on("data", (chunk) => chunks.push(chunk));
            req.on("end", () => {
                const raw = Buffer.concat(chunks).toString();
                res.setHeader("content-type", "application/json");
                if (url.pathname === "/api/v1/getUrlByEmail") {
                    res.end(JSON.stringify({
                        code: 200,
                        data: { url: rriot.r.a, country: "RU", countrycode: "7" }
                    }));
                    return;
                }
                if (url.pathname === "/api/v4/email/code/send") {
                    assert.match(raw, /email=user%40example.com/);
                    res.end(JSON.stringify({ code: 200 }));
                    return;
                }
                if (url.pathname === "/api/v3/key/sign") {
                    res.end(JSON.stringify({ code: 200, data: { k: "signed-key" } }));
                    return;
                }
                if (url.pathname === "/api/v3/app/agreement/latest") {
                    res.end(JSON.stringify({ code: 200, data: { majorVersion: 14, minorVersion: 0 } }));
                    return;
                }
                if (url.pathname === "/api/v4/auth/email/login/code") {
                    assert.match(raw, /code=123456/);
                    res.end(JSON.stringify({
                        code: 200,
                        data: { token: "tok", rriot }
                    }));
                    return;
                }
                if (url.pathname === "/api/v1/getHomeDetail") {
                    assert.equal(req.headers.authorization, "tok");
                    res.end(JSON.stringify({ code: 200, data: { rrHomeId: 42 } }));
                    return;
                }
                if (url.pathname === "/v3/user/homes/42") {
                    const expected = hawkHeader(rriot, "/v3/user/homes/42", {
                        timestamp: 1700000000,
                        nonce: "fixed-nonce"
                    });
                    assert.equal(req.headers.authorization, expected);
                    res.end(JSON.stringify({
                        success: true,
                        result: {
                            id: 42,
                            name: "Home",
                            products: [{ id: "p1", model: "roborock.vacuum.a15", name: "Roborock S7" }],
                            devices: [{
                                duid: "DUID1",
                                name: "Downstairs",
                                localKey: "local-secret",
                                productId: "p1",
                                fv: "02.16.12",
                                online: true
                            }],
                            rooms: [{ id: 7, name: "Kitchen" }]
                        }
                    }));
                    return;
                }
                res.statusCode = 404;
                res.end(JSON.stringify({ code: 404, msg: url.pathname }));
            });
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        const base = `http://127.0.0.1:${address.port}`;
        rriot.r.a = base;
        const client = new CloudClient({
            email: "user@example.com",
            clientId: "device-identifier",
            baseUrl: base,
            enforceHost: false,
            now: () => 1700000000,
            nonce: () => "fixed-nonce"
        });
        try {
            assert.equal(client.headerClientId(), "XLP+ZIqnBiCPTGuVLBmFiA==");
            const region = await client.detectRegion();
            assert.equal(region.country, "RU");
            assert.equal(region.countryCode, "7");
            const sent = await client.sendCode();
            assert.equal(sent.channel, "v4");
            const session = await client.loginWithCode("123456");
            assert.equal(session.userData.token, "tok");
            const home = await client.getDevices();
            assert.equal(home.devices.length, 1);
            assert.equal(home.devices[0].model, "roborock.vacuum.a15");
            assert.equal(home.devices[0].localKey, "local-secret");
            assert.equal(home.devices[0].firmware, "02.16.12");
            assert.equal(home.rooms[0].name, "Kitchen");
        } finally {
            await closeServer(server);
        }
    });

    test("invalid code is reported clearly", async () => {
        const server = http.createServer((req, res) => {
            res.setHeader("content-type", "application/json");
            const url = new URL(req.url, "http://127.0.0.1");
            if (url.pathname === "/api/v1/getUrlByEmail") {
                res.end(JSON.stringify({
                    code: 200,
                    data: { url: `http://127.0.0.1:${server.address().port}`, country: null, countrycode: null }
                }));
                return;
            }
            if (url.pathname === "/api/v1/loginWithCode") {
                res.end(JSON.stringify({ code: 2018, msg: "invalid" }));
                return;
            }
            res.end(JSON.stringify({ code: 500, msg: url.pathname }));
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const client = new CloudClient({
            email: "user@example.com",
            baseUrl: `http://127.0.0.1:${server.address().port}`,
            enforceHost: false
        });
        try {
            await assert.rejects(client.loginWithCode("0000"), (err) => {
                assert.ok(err instanceof CloudError);
                assert.equal(err.code, 2018);
                assert.match(err.message, /code/i);
                return true;
            });
        } finally {
            await closeServer(server);
        }
    });

    test("refuses a non-roborock host when enforcement is on", () => {
        const client = new CloudClient({
            email: "user@example.com",
            baseUrl: "https://evil.example",
            enforceHost: true
        });
        assert.throws(() => client.candidateBases(), /unexpected host/i);
    });
});
