"use strict";

const crypto = require("crypto");
const { BASE_URLS } = require("./constants");

const PROBE_ORDER = ["us", "eu", "cn", "ru"];

class CloudError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = "CloudError";
        this.code = options.code;
        this.statusCode = options.statusCode || 400;
    }
}

class CloudClient {
    /**
     * Roborock account HTTP API used only while fetching device keys.
     * Runtime vacuum control does not use this client.
     */
    constructor(options = {}) {
        this.email = options.email ? String(options.email).trim() : "";
        this.clientId = options.clientId || crypto.randomBytes(16).toString("base64url");
        this.region = options.region || "auto";
        this.baseUrl = options.baseUrl || null;
        this.country = options.country || null;
        this.countryCode = options.countryCode || null;
        this.userData = options.userData || null;
        this.enforceHost = options.enforceHost !== false;
        this.fetchImpl = options.fetchImpl || fetch;
        this.now = options.now || (() => Math.floor(Date.now() / 1000));
        this.nonce = options.nonce || (() => crypto.randomBytes(6).toString("base64url"));
    }

    headerClientId() {
        return crypto.createHash("md5")
            .update(Buffer.from(this.email, "utf8"))
            .update(Buffer.from(this.clientId, "utf8"))
            .digest("base64");
    }

    async detectRegion() {
        if (!this.email) {
            throw new CloudError("Email is required", { statusCode: 400 });
        }
        const bases = this.candidateBases();
        let lastError = null;
        for (const base of bases) {
            try {
                const response = await this.request(base, "POST", "/api/v1/getUrlByEmail", {
                    query: { email: this.email, needtwostepauth: "false" }
                });
                if (!response || response.code !== 200 || !response.data) {
                    lastError = mapLoginError(response, "Could not look up the account region");
                    continue;
                }
                const url = response.data.url;
                this.baseUrl = this.enforceHost ? assertCloudUrl(url) : stripSlash(url);
                this.country = response.data.country || this.country;
                this.countryCode = response.data.countrycode ?? response.data.countryCode ?? this.countryCode;
                return {
                    baseUrl: this.baseUrl,
                    country: this.country,
                    countryCode: this.countryCode,
                    clientId: this.clientId,
                    region: this.region
                };
            } catch (err) {
                lastError = err;
            }
        }
        throw lastError || new CloudError("No Roborock region matched this email. Check the address or pick the region yourself.", { statusCode: 404 });
    }

    candidateBases() {
        if (this.baseUrl) {
            return [this.enforceHost ? assertCloudUrl(this.baseUrl) : stripSlash(this.baseUrl)];
        }
        if (this.region && this.region !== "auto" && BASE_URLS[this.region]) {
            return [BASE_URLS[this.region]];
        }
        if (this.region && this.region !== "auto" && /^https:\/\//.test(this.region)) {
            return [this.enforceHost ? assertCloudUrl(this.region) : stripSlash(this.region)];
        }
        return PROBE_ORDER.map((key) => BASE_URLS[key]);
    }

    async ensureBase() {
        if (!this.baseUrl || !this.country) {
            await this.detectRegion();
        }
        return this.baseUrl;
    }

    async sendCode() {
        await this.ensureBase();
        if (this.country && this.countryCode !== null && this.countryCode !== undefined) {
            try {
                await this.sendCodeV4();
                return { ok: true, channel: "v4", baseUrl: this.baseUrl, clientId: this.clientId };
            } catch (err) {
                if (err.code === 3030) {
                    /* try the legacy endpoint below */
                } else {
                    throw err;
                }
            }
        }
        await this.sendCodeV1();
        return { ok: true, channel: "v1", baseUrl: this.baseUrl, clientId: this.clientId };
    }

    async sendCodeV4() {
        const response = await this.request(this.baseUrl, "POST", "/api/v4/email/code/send", {
            form: { email: this.email, type: "login", platform: "" },
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                header_clientlang: "en"
            }
        });
        assertOk(response, "Could not send the verification code");
    }

    async sendCodeV1() {
        const response = await this.request(this.baseUrl, "POST", "/api/v1/sendEmailCode", {
            query: { username: this.email, type: "auth" }
        });
        assertOk(response, "Could not send the verification code");
    }

    async loginWithCode(code) {
        await this.ensureBase();
        if (this.country && this.countryCode !== null && this.countryCode !== undefined) {
            try {
                return await this.loginWithCodeV4(code);
            } catch (err) {
                if (err.code === 2018 || err.code === 3006 || err.code === 3009 || err.code === 3039) {
                    throw err;
                }
            }
        }
        return this.loginWithCodeV1(code);
    }

    async loginWithCodeV4(code) {
        const mercyKs = crypto.randomBytes(12).toString("base64url").replace(/[^a-zA-Z0-9]/g, "a").slice(0, 16);
        const signed = await this.request(this.baseUrl, "POST", "/api/v3/key/sign", {
            query: { s: mercyKs }
        });
        assertOk(signed, "Could not sign the login request");
        const mercyK = signed.data && signed.data.k;
        if (!mercyK) {
            throw new CloudError("Roborock did not return a signature key");
        }
        const agreement = await this.agreementVersion();
        const response = await this.request(this.baseUrl, "POST", "/api/v4/auth/email/login/code", {
            form: {
                country: this.country,
                countryCode: String(this.countryCode),
                email: this.email,
                code: String(code).trim(),
                majorVersion: String(agreement.majorVersion),
                minorVersion: String(agreement.minorVersion)
            },
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                header_clientlang: "en",
                header_appversion: "4.54.02",
                header_phonesystem: "iOS",
                header_phonemodel: "iPhone16,1",
                "x-mercy-ks": mercyKs,
                "x-mercy-k": mercyK
            }
        });
        return this.acceptLogin(response);
    }

    async loginWithCodeV1(code) {
        const response = await this.request(this.baseUrl, "POST", "/api/v1/loginWithCode", {
            query: {
                username: this.email,
                verifycode: String(code).trim(),
                verifycodetype: "AUTH_EMAIL_CODE"
            }
        });
        return this.acceptLogin(response);
    }

    async loginWithPassword(password) {
        await this.ensureBase();
        const response = await this.request(this.baseUrl, "POST", "/api/v1/login", {
            query: {
                username: this.email,
                password,
                needtwostepauth: "false"
            }
        });
        if (!response || response.code !== 200) {
            const mapped = mapLoginError(response, "Password login failed");
            mapped.message += " Newer Roborock accounts often require the emailed code instead of a password.";
            throw mapped;
        }
        return this.acceptLogin(response);
    }

    acceptLogin(response) {
        assertOk(response, "Login failed");
        if (!response.data || typeof response.data !== "object") {
            throw new CloudError("Login response did not include account data");
        }
        this.userData = response.data;
        return {
            userData: response.data,
            baseUrl: this.baseUrl,
            country: this.country,
            countryCode: this.countryCode,
            clientId: this.clientId
        };
    }

    async agreementVersion() {
        try {
            const response = await this.request(this.baseUrl, "GET", "/api/v3/app/agreement/latest", {
                query: { country: this.country },
                headers: { header_clientlang: "en" }
            });
            const data = response && response.data;
            if (response && response.code === 200 && data && Number.isInteger(data.majorVersion)) {
                return { majorVersion: data.majorVersion, minorVersion: data.minorVersion || 0 };
            }
        } catch (_err) {
            /* fall through to the known-good default */
        }
        return { majorVersion: 14, minorVersion: 0 };
    }

    async getDevices() {
        if (!this.userData) {
            throw new CloudError("Sign in before loading devices", { statusCode: 401 });
        }
        const rriot = this.userData.rriot;
        if (!rriot || !rriot.u || !rriot.s || !rriot.h || !rriot.r || !rriot.r.a) {
            throw new CloudError("Login did not include the home-data credentials (rriot). Sign in again.");
        }
        const apiBase = this.enforceHost ? assertCloudUrl(rriot.r.a) : stripSlash(rriot.r.a);
        const iotBase = this.baseUrl || apiBase;
        const homeDetail = await this.request(iotBase, "GET", "/api/v1/getHomeDetail", {
            headers: { Authorization: this.userData.token || "" },
            hawk: false
        });
        if (!homeDetail || homeDetail.code !== 200 || !homeDetail.data || homeDetail.data.rrHomeId === undefined) {
            if (homeDetail && homeDetail.code === 2010) {
                throw new CloudError("Saved login expired. Send a new code and sign in again.", { code: 2010, statusCode: 401 });
            }
            throw mapLoginError(homeDetail, "Could not read the home id");
        }
        const homeId = homeDetail.data.rrHomeId;
        const paths = [`/v3/user/homes/${homeId}`, `/v2/user/homes/${homeId}`, `/user/homes/${homeId}`];
        let last = null;
        for (const path of paths) {
            const response = await this.request(apiBase, "GET", path, {
                hawk: rriot,
                headers: {}
            });
            last = response;
            if (response && response.success && response.result) {
                return {
                    homeId,
                    name: response.result.name || "",
                    rooms: normalizeRooms(response.result.rooms),
                    devices: normalizeDevices(response.result)
                };
            }
        }
        throw new CloudError(`Home data was rejected: ${summarize(last)}`, { statusCode: 502 });
    }

    async request(base, method, path, options = {}) {
        const url = new URL(stripSlash(base) + path);
        if (options.query) {
            for (const [key, value] of Object.entries(options.query)) {
                url.searchParams.set(key, value === undefined || value === null ? "" : String(value));
            }
        }
        const headers = {
            header_clientid: this.headerClientId(),
            Accept: "application/json",
            "User-Agent": "node-red-contrib-roborock-local/0.1.0",
            ...(options.headers || {})
        };
        if (options.hawk) {
            headers.Authorization = hawkHeader(options.hawk, path, {
                params: options.query,
                timestamp: this.now(),
                nonce: this.nonce()
            });
        }
        let body;
        if (options.form) {
            body = new URLSearchParams(options.form).toString();
            if (!headers["Content-Type"]) {
                headers["Content-Type"] = "application/x-www-form-urlencoded";
            }
        }
        let response;
        try {
            response = await this.fetchImpl(url, {
                method,
                headers,
                body,
                signal: AbortSignal.timeout(20000)
            });
        } catch (err) {
            throw new CloudError(`Network error contacting ${url.host}: ${err.message}`, { statusCode: 502 });
        }
        const text = await response.text();
        let json;
        try {
            json = text ? JSON.parse(text) : {};
        } catch (_err) {
            throw new CloudError(`Roborock returned a non-JSON response (${response.status})`, { statusCode: 502 });
        }
        return json;
    }
}

function hawkHeader(rriot, urlPath, { params, form, body, timestamp, nonce }) {
    const paramsHash = extraHash(params);
    const payloadHash = body !== undefined && body !== null
        ? crypto.createHash("md5").update(typeof body === "string" ? body : JSON.stringify(body)).digest("hex")
        : extraHash(form);
    const prestr = [
        rriot.u,
        rriot.s,
        nonce,
        String(timestamp),
        crypto.createHash("md5").update(urlPath).digest("hex"),
        paramsHash,
        payloadHash
    ].join(":");
    const mac = crypto.createHmac("sha256", Buffer.from(rriot.h, "utf8")).update(prestr).digest("base64");
    return `Hawk id="${rriot.u}",s="${rriot.s}",ts="${timestamp}",nonce="${nonce}",mac="${mac}"`;
}

function extraHash(values) {
    if (!values) {
        return "";
    }
    const keys = Object.keys(values).sort();
    if (keys.length === 0) {
        return "";
    }
    const joined = keys.map((key) => `${key}=${values[key]}`).join("&");
    return crypto.createHash("md5").update(joined).digest("hex");
}

function assertCloudUrl(value) {
    let url;
    try {
        url = new URL(value);
    } catch (_err) {
        throw new CloudError("Roborock returned an invalid URL");
    }
    if (url.protocol !== "https:") {
        throw new CloudError("Refusing a non-HTTPS Roborock URL");
    }
    const host = url.hostname.toLowerCase();
    if (host !== "roborock.com" && !host.endsWith(".roborock.com")) {
        throw new CloudError(`Refusing unexpected host ${host}. If your account uses another official host, open an issue.`);
    }
    return url.origin;
}

function stripSlash(value) {
    return String(value || "").replace(/\/+$/, "");
}

function assertOk(response, fallback) {
    if (response && response.code === 200) {
        return;
    }
    throw mapLoginError(response, fallback);
}

function mapLoginError(response, fallback) {
    const code = response && response.code;
    const msg = (response && (response.msg || response.message)) || fallback;
    if (code === 2018) {
        return new CloudError("That verification code was not accepted. Check the email and try again.", { code, statusCode: 401 });
    }
    if (code === 2008 || code === 3039) {
        return new CloudError("No Roborock account uses that email in this region.", { code, statusCode: 404 });
    }
    if (code === 9002) {
        return new CloudError("Too many code requests. Wait a few minutes and try again.", { code, statusCode: 429 });
    }
    if (code === 3009) {
        return new CloudError("Accept the user agreement in the Roborock app, then try again.", { code, statusCode: 403 });
    }
    if (code === 3006) {
        return new CloudError("The user agreement must be accepted again, or this is a Mi Home account rather than a Roborock account.", { code, statusCode: 403 });
    }
    if (code === 2003) {
        return new CloudError("That email address looks invalid.", { code, statusCode: 400 });
    }
    if (code === 2010) {
        return new CloudError("Saved login expired. Sign in again.", { code, statusCode: 401 });
    }
    return new CloudError(`${msg}${code !== undefined ? ` (code ${code})` : ""}`, { code, statusCode: 502 });
}

function summarize(response) {
    if (!response) {
        return "empty response";
    }
    return response.msg || response.message || `code ${response.code}`;
}

function normalizeRooms(rooms) {
    if (!Array.isArray(rooms)) {
        return [];
    }
    return rooms.map((room) => ({
        id: room.id !== undefined ? room.id : room.roomId,
        name: room.name || ""
    })).filter((room) => room.id !== undefined);
}

function normalizeDevices(home) {
    const products = {};
    for (const product of home.products || []) {
        products[String(product.id)] = product;
    }
    const devices = []
        .concat(home.devices || [])
        .concat(home.receivedDevices || [])
        .concat(home.received_devices || []);
    return devices.map((device) => {
        const product = products[String(device.productId || device.product_id)] || {};
        return {
            duid: device.duid,
            name: device.name || product.name || device.duid,
            localKey: device.localKey || device.local_key || "",
            model: product.model || device.model || "",
            productName: product.name || "",
            firmware: device.fv || device.firmware || "",
            online: device.online !== undefined ? device.online : null,
            pv: device.pv || "",
            sn: device.sn || "",
            productId: device.productId || device.product_id || ""
        };
    }).filter((device) => device.duid && device.localKey);
}

/**
 * Accept a Home Assistant roborock config entry, its data object, or user_data.
 * Error text never includes the pasted session.
 */
function parseImportedSession(raw) {
    let value = raw;
    if (typeof raw === "string") {
        const text = raw.trim();
        if (!text) {
            throw new CloudError("Paste the Home Assistant user_data JSON");
        }
        try {
            value = JSON.parse(text);
        } catch (_err) {
            throw new CloudError("That session text is not valid JSON");
        }
    }
    if (Array.isArray(value)) {
        const entry = value.find((item) => item && item.domain === "roborock")
            || value.find((item) => item && item.data && (item.data.user_data || item.data.userData));
        if (!entry) {
            throw new CloudError("No roborock config entry was found in that JSON array");
        }
        value = entry;
    }
    if (!value || typeof value !== "object") {
        throw new CloudError("Session JSON must be an object");
    }
    let container = value;
    if (container.data && typeof container.data === "object" && (container.data.user_data || container.data.userData)) {
        container = container.data;
    }
    const userData = container.user_data || container.userData || (
        container.rriot || container.token ? container : null
    );
    if (!userData || typeof userData !== "object" || Array.isArray(userData)) {
        throw new CloudError("Could not find user_data in that JSON. Paste the roborock config entry or its user_data object.");
    }
    const rriot = userData.rriot;
    const hasRriot = Boolean(rriot && rriot.u && rriot.s && rriot.h && rriot.r && rriot.r.a);
    if (!hasRriot) {
        throw new CloudError("user_data is missing rriot home-data credentials. Paste the full user_data object from Home Assistant, including token and rriot.");
    }
    return {
        userData,
        baseUrl: container.base_url || container.baseUrl || null,
        email: container.username || container.email || null,
        country: userData.country || null,
        countryCode: userData.countrycode ?? userData.countryCode ?? null
    };
}

function joinRooms(mapping, cloudRooms) {
    const names = new Map((cloudRooms || []).map((room) => [String(room.id), room.name]));
    if (!Array.isArray(mapping)) {
        return [];
    }
    return mapping.map((pair) => {
        if (!Array.isArray(pair)) {
            return null;
        }
        const segmentId = pair[0];
        const roomId = pair[1];
        return {
            segmentId,
            roomId,
            name: names.get(String(roomId)) || ""
        };
    }).filter(Boolean);
}

module.exports = {
    CloudClient,
    CloudError,
    hawkHeader,
    extraHash,
    assertCloudUrl,
    normalizeDevices,
    joinRooms,
    parseImportedSession,
    BASE_URLS
};
