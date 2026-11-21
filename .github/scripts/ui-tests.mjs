#!/usr/bin/env node
// UI test plan helper for CI. Reads apps/ios/JOEYYUITests/{shards,smoke,quarantine}.txt.
//
//   check                                   every UI test is in exactly one shard; smoke and quarantine entries exist
//   list  <smoke | shard N | all> [--include-quarantine]   test identifiers, one per line
//   args  <smoke | shard N | all> [--include-quarantine]   xcodebuild -only-testing arguments, one per line
//   summarize --suite NAME --log FILE --exit-status N [--expected FILE] [--out FILE]
//       Classifies an xcodebuild log run with -retry-tests-on-failure: a test that failed every attempt
//       is broken (a real failure), one that passed on retry is flaky, and runner or audit timeouts
//       (error -56) are infrastructure errors. Writes JSON, appends to $GITHUB_STEP_SUMMARY, and exits
//       non-zero unless the suite passed.
import { readFileSync, readdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const testsDir = join(root, "apps", "ios", "JOEYYUITests");
const target = "JOEYYUITests";

// Failures that say nothing about the app: the runner, simulator, or an audit timed out.
export const infraPattern = new RegExp([
  "Code=-56\\b", "\\(-56\\)", "error -56", "failed to complete in time",
  "Failed to (launch|terminate|install|get matching snapshot|get snapshot)",
  "Lost connection to", "Timed out while (loading|waiting)", "Early unexpected exit",
  "Test runner (exited|never began|failed)", "Unable to (boot|launch)", "failed to boot",
  "The test runner encountered an error", "Application .* is not running",
].join("|"), "i");

function readList(file, dir = testsDir) {
  return readFileSync(join(dir, file), "utf8").split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim()).filter(Boolean);
}

export function readShards(dir = testsDir) {
  const shards = new Map();
  let current = null;
  for (const line of readList("shards.txt", dir)) {
    const header = line.match(/^\[(\d+)\]$/);
    if (header) { current = header[1]; shards.set(current, []); continue; }
    if (current === null) throw new Error(`shards.txt: "${line}" is outside a [N] section`);
    shards.get(current).push(line);
  }
  return shards;
}

export function discoverTests(dir = testsDir) {
  const tests = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".swift")).sort()) {
    let cls = null;
    for (const raw of readFileSync(join(dir, file), "utf8").split(/\r?\n/)) {
      const line = raw.replace(/\/\/.*/, "");
      const c = line.match(/\bclass\s+(\w+)\s*:\s*XCTestCase\b/);
      if (c) cls = c[1];
      const m = line.match(/\bfunc\s+(test\w*)\s*\(/);
      if (m && cls) tests.push(`${cls}/${m[1]}`);
    }
  }
  return tests;
}

export function check(dir = testsDir) {
  const errors = [];
  const tests = discoverTests(dir);
  const known = new Set(tests);
  const shards = readShards(dir);
  const seen = new Map();
  for (const [shard, list] of shards) {
    for (const test of list) {
      if (!known.has(test)) errors.push(`shards.txt [${shard}]: ${test} is not a test method in ${target}`);
      if (seen.has(test)) errors.push(`shards.txt: ${test} is in shards [${seen.get(test)}] and [${shard}]`);
      seen.set(test, shard);
    }
  }
  for (const test of tests) {
    if (!seen.has(test)) errors.push(`${test} is in no shard: add it to one section of apps/ios/JOEYYUITests/shards.txt`);
  }
  const quarantine = readList("quarantine.txt", dir);
  for (const test of quarantine) {
    if (!known.has(test)) errors.push(`quarantine.txt: ${test} is not a test method in ${target}`);
  }
  for (const test of readList("smoke.txt", dir)) {
    if (!known.has(test)) errors.push(`smoke.txt: ${test} is not a test method in ${target}`);
    if (quarantine.includes(test)) errors.push(`smoke.txt: ${test} is quarantined; pick another smoke test`);
  }
  if (errors.length) {
    for (const error of errors) console.log(`::error::${error}`);
    process.exitCode = 1;
  } else {
    const sizes = [...shards].map(([s, l]) => `[${s}] ${l.length}`).join(", ");
    console.log(`${tests.length} UI tests, each in exactly one shard (${sizes}); ${quarantine.length} quarantined.`);
  }
  return errors;
}

export function select(kind, shard, includeQuarantine) {
  let tests;
  if (kind === "smoke") tests = readList("smoke.txt");
  else if (kind === "all") tests = [...readShards().values()].flat();
  else if (kind === "shard") {
    tests = readShards().get(String(shard));
    if (!tests) throw new Error(`No shard [${shard}] in shards.txt`);
  } else throw new Error(`Unknown selection "${kind}"`);
  if (includeQuarantine) return tests;
  const quarantine = new Set(readList("quarantine.txt"));
  return tests.filter((t) => !quarantine.has(t));
}

export function parseLog(text) {
  const results = new Map();
  const entry = (id) => {
    if (!results.has(id)) results.set(id, { passed: 0, failed: 0, skipped: 0, messages: [] });
    return results.get(id);
  };
  for (const line of text.split(/\r?\n/)) {
    const c = line.match(/Test Case '-\[(\w+)\.(\w+) (\w+)\]' (passed|failed|skipped)/);
    if (c) { entry(`${c[1]}/${c[2]}/${c[3]}`)[c[4]] += 1; continue; }
    const e = line.match(/error: -\[(\w+)\.(\w+) (\w+)\] : (.*)$/);
    if (e) entry(`${e[1]}/${e[2]}/${e[3]}`).messages.push(e[4].trim().slice(0, 300));
  }
  return results;
}

export function classify({ suite, log, exitStatus, expected }) {
  const results = parseLog(log);
  const broken = [], flaky = [], infra = [];
  for (const [test, r] of results) {
    const message = r.messages[0] ?? "";
    if (r.failed && r.passed) flaky.push({ test, message });
    else if (r.failed) {
      const allInfra = r.messages.length > 0 && r.messages.every((m) => infraPattern.test(m));
      (allInfra ? infra : broken).push({ test, message });
    }
  }
  let missing = [];
  if (expected) missing = expected.filter((t) => !results.has(t));
  else if (results.size === 0) missing = ["(no test results in the log)"];
  const allResolved = results.size > 0 && !missing.length &&
    [...results.values()].every((r) => r.passed || r.skipped || !r.failed);
  let status = "passed";
  if (broken.length) status = "failed";
  else if (infra.length || missing.length || (exitStatus !== 0 && !allResolved)) status = "error";
  return { suite, status, exitStatus, total: results.size, broken, flaky, infra, missing };
}

function markdown(result) {
  const icon = { passed: "✅", failed: "❌", error: "⚠️" }[result.status];
  const lines = [`### ${icon} ${result.suite}: ${result.status} (${result.total} tests)`];
  const section = (title, list) => {
    if (!list.length) return;
    lines.push(`**${title}**`);
    for (const item of list) {
      lines.push(typeof item === "string" ? `- \`${item}\`` : `- \`${item.test}\`${item.message ? `: ${item.message}` : ""}`);
    }
  };
  section("Failed twice (broken)", result.broken);
  section("Infrastructure errors (no rollback)", result.infra);
  section("Did not run", result.missing);
  section("Flaky (passed on retry)", result.flaky);
  if (result.status === "error" && !result.infra.length && !result.missing.length) {
    lines.push(`xcodebuild exited with ${result.exitStatus} without a test failure (build, runner, or simulator problem).`);
  }
  return lines.join("\n") + "\n";
}

function option(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function selection(args) {
  const [kind, shard] = args;
  return select(kind, kind === "shard" ? shard : undefined, args.includes("--include-quarantine"));
}

function main(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case "check":
      check();
      break;
    case "list":
      for (const test of selection(args)) console.log(`${target}/${test}`);
      break;
    case "args":
      for (const test of selection(args)) console.log(`-only-testing:${target}/${test}`);
      break;
    case "summarize": {
      const suite = option(args, "--suite");
      const logFile = option(args, "--log");
      const expectedFile = option(args, "--expected");
      const out = option(args, "--out");
      const log = logFile && existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
      const expected = expectedFile
        ? readFileSync(expectedFile, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        : undefined;
      const result = classify({ suite, log, exitStatus: Number(option(args, "--exit-status") ?? 0), expected });
      if (out) writeFileSync(out, JSON.stringify(result, null, 2));
      const md = markdown(result);
      process.stdout.write(md);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
      for (const { test, message } of result.broken) console.log(`::error title=${test}::${message || "failed twice"}`);
      for (const { test } of result.flaky) console.log(`::warning title=Flaky ${test}::Passed on retry`);
      if (result.status !== "passed") process.exitCode = 1;
      break;
    }
    default:
      console.error("Usage: ui-tests.mjs check | list | args | summarize (see the header comment)");
      process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
