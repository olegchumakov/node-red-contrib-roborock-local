"use strict";

const { registerAdmin } = require("../lib/admin");

module.exports = function (RED) {
    registerAdmin(RED);

    function RoborockAccountNode(config) {
        RED.nodes.createNode(this, config);
        this.region = config.region || "auto";
        this.baseUrl = config.baseUrl || "";
        this.email = this.credentials && this.credentials.email;
        this.clientId = this.credentials && this.credentials.clientId;
    }

    RED.nodes.registerType("roborock-account", RoborockAccountNode, {
        credentials: {
            email: { type: "text" },
            clientId: { type: "text" },
            userData: { type: "password" }
        }
    });
};
