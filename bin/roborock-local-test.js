#!/usr/bin/env node
"use strict";

const { localMain } = require("../lib/cli");

localMain(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
}).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
});
