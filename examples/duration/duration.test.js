import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration, parseDuration } from "./duration.js";

test("hours", () => assert.equal(parseDuration("2h"), 7200));
test("combined", () => assert.equal(parseDuration("1h30m"), 5400));
test("seconds and minutes", () => assert.equal(parseDuration("45m10s"), 2710));
test("any order + spaces", () => assert.equal(parseDuration(" 10s 1m "), 70));
test("invalid", () => { assert.ok(Number.isNaN(parseDuration("abc"))); assert.ok(Number.isNaN(parseDuration("5x"))); assert.ok(Number.isNaN(parseDuration(""))); });
test("format", () => { assert.equal(formatDuration(5400), "1h30m"); assert.equal(formatDuration(70), "1m10s"); assert.equal(formatDuration(0), "0s"); });
test("round trip", () => { for (const s of [1, 59, 61, 3599, 3601, 86399]) assert.equal(parseDuration(formatDuration(s)), s); });
