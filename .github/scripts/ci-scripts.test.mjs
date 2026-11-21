// Run with: node --test .github/scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classify, check } from "./ui-tests.mjs";
import { collect, decideAttribution } from "./post-merge.mjs";

const line = (name, result) => `Test Case '-[JOEYYUITests.CustomerFlowTests ${name}]' ${result} (1.0 seconds).`;
const error = (name, message) => `/x/CustomerFlowTests.swift:1: error: -[JOEYYUITests.CustomerFlowTests ${name}] : ${message}`;
const id = (name) => `JOEYYUITests/CustomerFlowTests/${name}`;

test("a test that fails both attempts is broken; one that passes on retry is flaky", () => {
  const log = [
    line("testA", "failed"), error("testA", "XCTAssertEqual failed"), line("testA", "failed"),
    line("testB", "failed"), error("testB", "Contrast failed"), line("testB", "passed"),
    line("testC", "passed"),
  ].join("\n");
  const r = classify({ suite: "s", log, exitStatus: 65, expected: [id("testA"), id("testB"), id("testC")] });
  assert.equal(r.status, "failed");
  assert.deepEqual(r.broken.map((b) => b.test), [id("testA")]);
  assert.deepEqual(r.flaky.map((b) => b.test), [id("testB")]);
});

test("passing on retry is a pass even if xcodebuild exits non-zero", () => {
  const log = [line("testB", "failed"), line("testB", "passed")].join("\n");
  assert.equal(classify({ suite: "s", log, exitStatus: 65, expected: [id("testB")] }).status, "passed");
});

test("audit timeouts (-56) and runner errors are infrastructure, not failures", () => {
  const log = [
    line("testA", "failed"),
    error("testA", 'failed: caught error: "Error Domain=com.apple.dt.xctest Code=-56 "Audit failed to complete in time.""'),
    line("testA", "failed"),
    error("testA", "Failed to launch app: Lost connection to the test manager service"),
  ].join("\n");
  const r = classify({ suite: "s", log, exitStatus: 65, expected: [id("testA")] });
  assert.equal(r.status, "error");
  assert.equal(r.broken.length, 0);
  assert.equal(r.infra.length, 1);
});

test("a build failure or runner crash with no results is an error", () => {
  assert.equal(classify({ suite: "s", log: "** BUILD FAILED **", exitStatus: 65, expected: [id("testA")] }).status, "error");
  assert.equal(classify({ suite: "unit", log: "", exitStatus: 70 }).status, "error");
  const partial = classify({ suite: "s", log: line("testA", "passed"), exitStatus: 65, expected: [id("testA"), id("testB")] });
  assert.equal(partial.status, "error");
  assert.deepEqual(partial.missing, [id("testB")]);
});

test("check fails when a test is in no shard, in two shards, or a list names an unknown test", () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-"));
  writeFileSync(join(dir, "A.swift"), "final class A: XCTestCase {\n  func testOne() {}\n  func testTwo() throws {}\n  // func testOld() {}\n}\n");
  writeFileSync(join(dir, "quarantine.txt"), "A/testGone\n");
  writeFileSync(join(dir, "smoke.txt"), "A/testOne\n");
  writeFileSync(join(dir, "shards.txt"), "[1]\nA/testOne\n[2]\nA/testOne\n");
  const errors = check(dir);
  process.exitCode = 0;
  assert.ok(errors.some((e) => e.includes("A/testTwo is in no shard")));
  assert.ok(errors.some((e) => e.includes("A/testOne is in shards [1] and [2]")));
  assert.ok(errors.some((e) => e.includes("quarantine.txt: A/testGone")));
  assert.ok(!errors.some((e) => e.includes("testOld")));
  writeFileSync(join(dir, "shards.txt"), "[1]\nA/testOne\n[2]\nA/testTwo\n");
  writeFileSync(join(dir, "quarantine.txt"), "A/testTwo\n");
  assert.deepEqual(check(dir), []);
});

test("a suite that never reported counts as an error, and real failures win over errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "results-"));
  writeFileSync(join(dir, "ui-shard-1.json"), JSON.stringify({ suite: "ui-shard-1", status: "failed", broken: [{ test: "T", message: "m" }], flaky: [] }));
  const v = collect(dir, ["ui-shard-1", "ui-shard-2"]);
  assert.equal(v.outcome, "failed");
  assert.deepEqual(v.errors, ["ui-shard-2"]);
  assert.equal(collect(mkdtempSync(join(tmpdir(), "empty-")), ["ui-shard-1"]).outcome, "error");
});

test("only a failure that's new since the previous commit is reverted", () => {
  const failures = [{ test: "T1" }];
  assert.equal(decideAttribution(failures, null).revert, true);
  assert.equal(decideAttribution(failures, { verdict: { outcome: "passed", failures: [] } }).revert, true);
  const inherited = decideAttribution(failures, { verdict: { outcome: "failed", failures: [{ test: "T1" }] } });
  assert.equal(inherited.revert, false);
  assert.equal(inherited.inherited, true);
  assert.equal(decideAttribution([{ test: "T2" }], { verdict: { outcome: "failed", failures: [{ test: "T1" }] } }).revert, true);
  assert.equal(decideAttribution(failures, { verdict: { outcome: "error", failures: [] } }).revert, false);
});
