// Run with: node --test .github/scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { classify, check } from "./ui-tests.mjs";
import { collect, decideAttribution, splitFailures } from "./post-merge.mjs";

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

test("only unit, API, and web failures can roll back; UI failures never do", () => {
  const { deterministic, ui } = splitFailures([
    { suite: "unit-tests", test: "U" }, { suite: "api-tests", test: "A" }, { suite: "web-build", test: "W" },
    { suite: "ui-shard-1", test: "UI1" }, { suite: "ui-shard-4", test: "UI4" },
  ]);
  assert.deepEqual(deterministic.map((f) => f.test), ["U", "A", "W"]);
  assert.deepEqual(ui.map((f) => f.test), ["UI1", "UI4"]);
});

test("only a deterministic failure that's new since the previous commit is reverted", () => {
  const failures = [{ suite: "unit-tests", test: "T1" }];
  assert.equal(decideAttribution(failures, null).revert, true);
  assert.equal(decideAttribution(failures, { verdict: { outcome: "passed", failures: [] } }).revert, true);
  const inherited = decideAttribution(failures, { verdict: { outcome: "failed", failures: [{ test: "T1" }] } });
  assert.equal(inherited.revert, false);
  assert.equal(inherited.inherited, true);
  assert.equal(decideAttribution([{ suite: "unit-tests", test: "T2" }], { verdict: { outcome: "failed", failures: [{ test: "T1" }] } }).revert, true);
  // The previous commit's UI shards erroring or failing doesn't block a unit-test rollback…
  const uiError = { outcome: "error", failures: [], suites: [{ suite: "unit-tests", status: "passed" }, { suite: "ui-shard-2", status: "error" }] };
  assert.equal(decideAttribution(failures, { verdict: uiError }).revert, true);
  // …but if the same suite didn't finish on the previous commit, the failure can't be attributed.
  const unitError = { outcome: "error", failures: [], suites: [{ suite: "unit-tests", status: "error" }] };
  assert.equal(decideAttribution(failures, { verdict: unitError }).revert, false);
});

// Runs the whole verdict in DRY_RUN mode against a throwaway git repo and returns what it would do.
function dryRunVerdict(results, { expected = results.map((r) => r.suite), rollback = "true" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "verdict-"));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  const work = join(dir, "work");
  git(dir, "clone", "-q", origin, work);
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "change");
  git(work, "push", "-q", "origin", "HEAD:main");
  const resultsDir = join(dir, "results");
  mkdirSync(resultsDir);
  for (const r of results) writeFileSync(join(resultsDir, `${r.suite}.json`), JSON.stringify({ flaky: [], infra: [], missing: [], ...r }));
  const script = join(dirname(fileURLToPath(import.meta.url)), "post-merge.mjs");
  const run = spawnSync(process.execPath, [script], {
    cwd: work, encoding: "utf8",
    env: { ...process.env, DRY_RUN: "1", SHA: git(work, "rev-parse", "HEAD"), BRANCH: "main", BASE: git(work, "rev-parse", "HEAD~1"),
      MODE: "manual", ROLLBACK: rollback, EXPECTED: expected.join(","), RESULTS_DIR: resultsDir,
      GITHUB_REPOSITORY: "", GITHUB_STEP_SUMMARY: "", GH_TOKEN: "" },
  });
  assert.equal(run.stderr.includes("Error"), false, run.stderr);
  return run.stdout;
}

test("verdict: UI-only failures set a failure status and notify, but don't revert or verify", () => {
  const out = dryRunVerdict([
    { suite: "unit-tests", status: "passed", broken: [] },
    { suite: "ui-shard-1", status: "failed", broken: [{ test: "JOEYYUITests/A/testX", message: "flaky" }] },
  ]);
  assert.match(out, /commit status failure .*UI test\(s\) failed twice after merge \(not reverted\)/);
  assert.match(out, /Open issue "UI tests failed after merge"/);
  assert.doesNotMatch(out, /Revert |Move tag/);
});

test("verdict: unit, API, or web failures revert the merge", () => {
  for (const suite of ["unit-tests", "api-tests", "web-build"]) {
    const out = dryRunVerdict([
      { suite, status: "failed", broken: [{ test: `${suite}: T`, message: "m" }] },
      { suite: "ui-shard-1", status: "failed", broken: [{ test: "JOEYYUITests/A/testX" }] },
    ]);
    assert.match(out, /commit status failure .*unit\/API\/web failure/, suite);
    assert.match(out, /\[dry run\] Revert [0-9a-f]{7} on main/, suite);
    assert.doesNotMatch(out, /Move tag/, suite);
  }
});

test("verdict: infrastructure errors never revert; green moves the verified tag", () => {
  const error = dryRunVerdict([{ suite: "unit-tests", status: "passed", broken: [] }], { expected: ["unit-tests", "web-build"] });
  assert.match(error, /commit status error/);
  assert.doesNotMatch(error, /Revert |Move tag/);
  const green = dryRunVerdict([{ suite: "unit-tests", status: "passed", broken: [] }]);
  assert.match(green, /commit status success/);
  assert.match(green, /Move tag verified to/);
});