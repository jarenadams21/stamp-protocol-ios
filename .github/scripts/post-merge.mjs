#!/usr/bin/env node
// Post-merge verdict: reads every suite's result (results/*.json from ui-tests.mjs summarize and the
// API/web jobs) and then, for the tested commit:
//   passed  commit status success, and the verified tag moves to it
//   error   (build, runner, simulator, audit timeout) commit status error and a notice; no revert
//   failed  (a test failed twice) revert the merge on the branch, comment on its pull request, and
//           open or update the "<branch> was rolled back" issue
// Safety: never reverts a rollback commit, never force-pushes, and only reverts when the failure is
// new in this commit (the previous commit's validation passed). Anything it can't do safely becomes an
// issue instead. Environment: SHA, BRANCH, BASE, MODE (merge|manual|nightly), ROLLBACK, EXPECTED
// (comma-separated suites), RESULTS_DIR, GITHUB_* and GH_TOKEN. DRY_RUN=1 prints actions instead.
import { readFileSync, readdirSync, writeFileSync, appendFileSync, existsSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

export const MARKER = "[post-merge rollback]";
const CONTEXT = "Post-merge validation";
const env = process.env;
const dryRun = env.DRY_RUN === "1";
const repo = env.GITHUB_REPOSITORY;
const runUrl = `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`;

function sh(cmd, args, { allowFail = false, input } = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (allowFail) return null;
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${error.stderr || error.message}`);
  }
}

// Side effects go through here so DRY_RUN can show them without acting.
function act(description, fn) {
  if (dryRun) { console.log(`[dry run] ${description}`); return null; }
  console.log(description);
  return fn();
}

const short = (sha) => sha.slice(0, 7);

export function collect(dir, expected) {
  const results = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
    : [];
  for (const suite of expected) {
    if (!results.some((r) => r.suite === suite)) {
      results.push({ suite, status: "error", broken: [], flaky: [], infra: [],
        missing: ["(the job didn't report: build, setup, or runner failure)"] });
    }
  }
  const failures = results.flatMap((r) => (r.broken ?? []).map((b) => ({ suite: r.suite, ...b })));
  const errors = results.filter((r) => r.status === "error").map((r) => r.suite);
  const flaky = results.flatMap((r) => (r.flaky ?? []).map((f) => ({ suite: r.suite, ...f })));
  const outcome = failures.length ? "failed" : errors.length ? "error" : "passed";
  return { outcome, failures, errors, flaky, suites: results.map((r) => ({ suite: r.suite, status: r.status })) };
}

const failureList = (failures) =>
  failures.map((f) => `- \`${f.test}\`${f.message ? `: ${f.message.replace(/\s+/g, " ")}` : ""}`).join("\n");

function setStatus(sha, state, description) {
  act(`Set commit status ${state} on ${short(sha)}: ${description}`, () =>
    sh("gh", ["api", "-X", "POST", `repos/${repo}/statuses/${sha}`, "-f", `state=${state}`,
      "-f", `context=${CONTEXT}`, "-f", `target_url=${runUrl}`, "-f", `description=${description.slice(0, 139)}`]));
}

function pullRequestFor(sha) {
  const number = sh("gh", ["api", `repos/${repo}/commits/${sha}/pulls`, "--jq", ".[0].number // empty"], { allowFail: true });
  return number ? Number(number) : null;
}

function comment(pr, body) {
  if (!pr) return;
  act(`Comment on #${pr}`, () => sh("gh", ["pr", "comment", String(pr), "-R", repo, "--body-file", "-"], { input: body }));
}

function upsertIssue(title, body) {
  const existing = sh("gh", ["issue", "list", "-R", repo, "--state", "open", "--search", `"${title}" in:title`,
    "--json", "number,title", "--jq", `map(select(.title == ${JSON.stringify(title)})) | .[0].number // empty`],
  { allowFail: true });
  if (existing) {
    act(`Comment on issue #${existing} (${title})`, () =>
      sh("gh", ["issue", "comment", existing, "-R", repo, "--body-file", "-"], { input: body }));
  } else {
    act(`Open issue "${title}"`, () =>
      sh("gh", ["issue", "create", "-R", repo, "--title", title, "--body-file", "-"], { input: body }));
  }
}

function moveVerifiedTag(sha, branch) {
  // Not "verified/<branch>": git can't have both refs/tags/verified and refs/tags/verified/….
  const tag = branch === "main" ? "verified" : `verified-${branch.replaceAll("/", "-")}`;
  sh("git", ["fetch", "--force", "origin", `+refs/tags/${tag}:refs/tags/${tag}`], { allowFail: true });
  const current = sh("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`], { allowFail: true });
  if (current && sh("git", ["merge-base", "--is-ancestor", current, sha], { allowFail: true }) === null) {
    console.log(`${tag} (${short(current)}) is not an ancestor of ${short(sha)}; leaving it.`);
    return;
  }
  act(`Move tag ${tag} to ${short(sha)}`, () => {
    sh("git", ["tag", "-f", tag, sha]);
    sh("git", ["push", "--force", "origin", `refs/tags/${tag}`]);
  });
}

// The run that validated `sha` (the commit before this merge), after any still-running earlier runs finish.
async function previousVerdict(parent) {
  const self = JSON.parse(sh("gh", ["api", `repos/${repo}/actions/runs/${env.GITHUB_RUN_ID}`]));
  const deadline = Date.now() + 45 * 60 * 1000;
  for (;;) {
    const runs = JSON.parse(sh("gh", ["api", `repos/${repo}/actions/workflows/${self.workflow_id}/runs?branch=${encodeURIComponent(env.BRANCH)}&per_page=50`])).workflow_runs;
    const pending = runs.filter((r) => r.id !== self.id && r.status !== "completed" && r.created_at < self.created_at);
    if (!pending.length || Date.now() > deadline) break;
    console.log(`Waiting for ${pending.length} earlier validation run(s) to finish…`);
    await new Promise((resolve) => setTimeout(resolve, 30000));
  }
  const runs = JSON.parse(sh("gh", ["api", `repos/${repo}/actions/workflows/${self.workflow_id}/runs?head_sha=${parent}&per_page=20`])).workflow_runs
    .filter((r) => r.id !== self.id && r.status === "completed");
  for (const run of runs) {
    const dir = mkdtempSync(join(tmpdir(), "verdict-"));
    if (sh("gh", ["run", "download", String(run.id), "-R", repo, "-n", "verdict", "-D", dir], { allowFail: true }) !== null &&
        existsSync(join(dir, "verdict.json"))) {
      return { run, verdict: JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8")) };
    }
  }
  return null;
}

export function decideAttribution(failures, previous) {
  if (!previous) return { revert: true, reason: "no earlier validation of the previous commit" };
  const { verdict } = previous;
  if (verdict.outcome === "passed") return { revert: true, reason: "the previous commit passed validation" };
  if (verdict.outcome === "failed") {
    const before = new Set(verdict.failures.map((f) => f.test));
    const fresh = failures.filter((f) => !before.has(f.test));
    if (!fresh.length) return { revert: false, inherited: true, reason: "the same tests already failed on the previous commit" };
    return { revert: true, reason: "new failures that the previous commit didn't have" };
  }
  return { revert: false, reason: "the previous commit's validation didn't finish, so the failure can't be attributed to this merge" };
}

function revert(commits, branch, subject, failures) {
  const message = [
    `Revert "${subject}" ${MARKER}`, "",
    `Post-merge validation failed for ${short(commits[0])}: ${runUrl}`, "",
    "Failed twice:", ...failures.map((f) => `- ${f.test}`), "",
    ...commits.map((c) => `This reverts commit ${c}.`),
  ].join("\n");
  if (dryRun) { console.log(`[dry run] Revert ${commits.map(short).join(", ")} on ${branch}`); return { sha: "0000000" }; }
  sh("git", ["config", "user.name", "github-actions[bot]"]);
  sh("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  for (let attempt = 1; attempt <= 5; attempt++) {
    sh("git", ["fetch", "origin", branch]);
    sh("git", ["checkout", "-B", "post-merge-rollback", `origin/${branch}`]);
    for (const commit of commits) {
      const parents = sh("git", ["rev-list", "--parents", "-n", "1", commit]).split(" ").length - 1;
      const ok = sh("git", ["revert", "--no-commit", ...(parents > 1 ? ["-m", "1"] : []), commit], { allowFail: true });
      if (ok === null) {
        sh("git", ["revert", "--abort"], { allowFail: true });
        sh("git", ["reset", "--hard", `origin/${branch}`]);
        return { conflict: true };
      }
    }
    if (sh("git", ["diff", "--cached", "--quiet"], { allowFail: true }) !== null) return { empty: true };
    sh("git", ["commit", "-F", "-"], { input: message });
    try {
      execFileSync("git", ["push", "origin", `HEAD:refs/heads/${branch}`], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      return { sha: sh("git", ["rev-parse", "HEAD"]) };
    } catch (error) {
      const stderr = String(error.stderr);
      console.log(stderr);
      if (/workflow/i.test(stderr) && /permission|refusing/i.test(stderr)) return { workflowFiles: true };
      if (!/rejected|fetch first|non-fast-forward/i.test(stderr)) return { pushFailed: stderr.trim().split("\n").slice(-3).join(" ") };
    }
  }
  return { pushFailed: "the branch kept moving" };
}

async function main() {
  const { SHA: sha, BRANCH: branch, MODE: mode } = env;
  const base = env.BASE || null;
  const rollback = env.ROLLBACK === "true";
  const expected = (env.EXPECTED ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const verdict = { sha, branch, mode, runUrl, ...collect(env.RESULTS_DIR ?? "results", expected) };
  writeFileSync("verdict.json", JSON.stringify(verdict, null, 2));

  const summary = [`## ${CONTEXT}: ${verdict.outcome} — \`${branch}\` @ ${short(sha)} (${mode})`, "",
    "| Suite | Result |", "|---|---|", ...verdict.suites.map((s) => `| ${s.suite} | ${s.status} |`), ""];
  if (verdict.failures.length) summary.push("**Failed twice**", failureList(verdict.failures), "");
  if (verdict.flaky.length) summary.push("**Flaky (passed on retry)**", failureList(verdict.flaky), "");
  const report = (line) => { summary.push(line); console.log(line); };

  const pr = mode === "merge" ? pullRequestFor(sha) : null;
  const subject = sh("git", ["log", "-1", "--format=%s", sha]);
  const commits = base ? sh("git", ["rev-list", "--first-parent", `${base}..${sha}`]).split("\n").filter(Boolean) : [sha];

  if (mode === "nightly") {
    report(verdict.outcome === "passed" ? "Nightly run passed, including quarantined tests." : "Nightly run: see failures above (quarantined tests included; nothing is reverted).");
  } else if (verdict.outcome === "passed") {
    setStatus(sha, "success", "Full test suite passed after merge");
    moveVerifiedTag(sha, branch);
    report(`Verified ${short(sha)}.`);
  } else if (verdict.outcome === "error") {
    setStatus(sha, "error", `Couldn't finish: ${verdict.errors.join(", ")} (not a test failure; not reverted)`);
    comment(pr, `### ⚠️ Post-merge validation couldn't finish\n\n${verdict.errors.map((s) => `\`${s}\``).join(", ")} hit a build, runner, or simulator problem, not a test failure, so nothing was reverted. [Run](${runUrl}) — re-run the failed jobs to validate ${short(sha)}.`);
    report("Not a test failure, so nothing was reverted.");
  } else {
    setStatus(sha, "failure", `${verdict.failures.length} test(s) failed twice after merge`);
    const attention = (why) => {
      const body = `Post-merge validation of ${short(sha)}${pr ? ` (#${pr})` : ""} on \`${branch}\` found real test failures, but it **did not revert** because ${why}.\n\n${failureList(verdict.failures)}\n\n[Run](${runUrl})`;
      upsertIssue(`\`${branch}\` needs attention: post-merge validation failed`, body);
      comment(pr, `### ❌ Post-merge validation failed (not reverted)\n\n${body}`);
      report(`Not reverted: ${why}.`);
    };
    if (!rollback) {
      report("Rollback is off for this run, so nothing was reverted.");
    } else if (commits.some((c) => sh("git", ["log", "-1", "--format=%B", c]).includes(MARKER))) {
      report("This commit is a rollback; rollbacks are never reverted.");
    } else if (sh("git", ["log", `origin/${branch}`, "--format=%H", `--grep=This reverts commit ${sha}`]) ) {
      report(`${short(sha)} has already been reverted.`);
    } else {
      const previous = mode === "merge" && base ? await previousVerdict(base) : null;
      const decision = decideAttribution(verdict.failures, previous);
      report(`Attribution: ${decision.reason}${previous ? ` ([run](${previous.run.html_url}))` : ""}.`);
      if (decision.inherited) {
        comment(pr, `### ❌ Post-merge validation failed\n\nThese tests already failed on the commit before ${short(sha)}, so that merge's rollback covers them and this one was not reverted.\n\n${failureList(verdict.failures)}\n\n[Run](${runUrl})`);
      } else if (!decision.revert) {
        attention(decision.reason);
      } else {
        const result = revert(commits, branch, subject, verdict.failures);
        if (result.sha) {
          const reverted = short(result.sha);
          comment(pr, `### ↩️ Reverted: tests failed after merge\n\nThis pull request merged as ${short(sha)}. The full test suite then failed on it, so ${reverted} reverted it on \`${branch}\`.\n\n**Failed twice:**\n${failureList(verdict.failures)}\n\n[Run, logs, and test results](${runUrl}) (the \`xcresult-*\` artifacts have screenshots).\n\nTo reland, fix the failure and open a new pull request (you can start by reverting ${reverted}).`);
          upsertIssue(`\`${branch}\` was rolled back`, `${reverted} reverted ${short(sha)}${pr ? ` (#${pr})` : ""} "${subject}" because tests failed after merge.\n\n${failureList(verdict.failures)}\n\n[Run](${runUrl}). Close this issue once the change relands.`);
          report(`Reverted in ${reverted}.`);
        } else if (result.conflict) {
          attention("a later change depends on it and the revert conflicts; revert it by hand");
        } else if (result.workflowFiles) {
          attention("it changes workflow files, which the workflow token can't push; revert it by hand");
        } else if (result.empty) {
          report("Reverting produced no changes; nothing pushed.");
        } else {
          attention(`the revert couldn't be pushed (${result.pushFailed})`);
        }
      }
    }
  }
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary.join("\n") + "\n");
  if (verdict.outcome !== "passed") process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
