"use strict";

const fs = require("fs");
const path = require("path");
const { run } = require("node:test");
const reporters = require("node:test/reporters");

const dir = __dirname;
const files = fs.readdirSync(dir)
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => path.join(dir, name));

// Node 18's CLI has no --test-timeout. run({ timeout }) is the same per-test
// limit and exists on 18, 20, and 22. Pipe into the spec reporter; compose()
// does not pull this stream, so the run would exit before any test starts.
const tests = run({ files, timeout: 30000 });
tests.on("test:fail", () => {
    process.exitCode = 1;
});

const reporter = tests.pipe(new reporters.spec());
reporter.pipe(process.stdout);
reporter.on("end", () => {
    process.exit(process.exitCode || 0);
});
