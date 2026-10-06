#!/usr/bin/env node
"use strict";

const { cloudMain } = require("../lib/cli");

cloudMain(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
}).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
});
