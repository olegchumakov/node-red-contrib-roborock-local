"use strict";

/** Protocol constants shared with the Roborock local TCP stack (port 58867). */

const SALT = Buffer.from("TXdfu$jyZ#TZHsg4", "utf8");
const BROADCAST_TOKEN = Buffer.from("qWKYcdQWrbm9hPqe", "utf8");
const A01_HASH = "726f626f726f636b2d67a6d6da";
const B01_HASH = "5wwh9ikChRjASpMU8cxg7o1d2E";

const TCP_PORT = 58867;
const DISCOVERY_PORT = 58866;

const PROTOCOL = {
    CONNECT: 0,
    CONNACK: 1,
    PING: 2,
    PONG: 3,
    PUBLISH: 4,
    PUBACK: 5
};

const BASE_URLS = {
    us: "https://usiot.roborock.com",
    eu: "https://euiot.roborock.com",
    cn: "https://cniot.roborock.com",
    ru: "https://ruiot.roborock.com"
};

const DEFAULT_KEEPALIVE_SECONDS = 10;

module.exports = {
    SALT,
    BROADCAST_TOKEN,
    A01_HASH,
    B01_HASH,
    TCP_PORT,
    DISCOVERY_PORT,
    PROTOCOL,
    BASE_URLS,
    DEFAULT_KEEPALIVE_SECONDS
};
