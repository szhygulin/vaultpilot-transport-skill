/**
 * Tests for `helper/index.js` — the CLI dispatcher.
 *
 * Drives the helper as a subprocess (spawns `node helper/index.js`)
 * with a JSON envelope on stdin and asserts on the stdout JSON +
 * exit code. This is the closest we can get to "what the agent
 * actually invokes" without a real Ledger.
 *
 * For scenarios that require a working signer, we set
 * `VAULTPILOT_TRANSPORT_TEST_FAKE=1` — the production helper
 * doesn't read this; it's only consulted by `tron.test.js` for
 * unit-level mock injection. The dispatcher tests below cover
 * pre-Ledger paths (validation, version, unknown chain) plus the
 * `chain_not_supported_yet` future-chain branch, all of which
 * exit BEFORE any Ledger transport is opened.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HELPER = join(dirname(fileURLToPath(import.meta.url)), "..", "helper", "index.js");

/** Spawn the helper, write `input` (string) to stdin, return { stdout, stderr, code }. */
function runHelper(input) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [HELPER], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b) => (stdout += b.toString()));
    proc.stderr.on("data", (b) => (stderr += b.toString()));
    proc.on("close", (code) => resolve({ stdout, stderr, code }));
    proc.stdin.end(input);
  });
}

describe("dispatcher — envelope validation", () => {
  it("rejects malformed JSON on stdin with INVALID_INPUT exit 1", async () => {
    const { stdout, code } = await runHelper("not-json{");
    const body = JSON.parse(stdout);
    assert.equal(code, 1);
    assert.equal(body.ok, false);
    assert.equal(body.error, "invalid_input");
    assert.match(body.error_description, /Failed to read stdin as JSON/);
    assert.equal(body.version, 1);
  });

  it("rejects an envelope without version", async () => {
    const { stdout, code } = await runHelper(
      JSON.stringify({ chain: "tron", path: "m/44'/195'/0'/0/0", tx: {} }),
    );
    const body = JSON.parse(stdout);
    assert.equal(code, 1);
    assert.equal(body.error, "invalid_input");
    assert.match(body.error_description, /version/);
  });

  it("rejects an envelope with the wrong version", async () => {
    const { stdout, code } = await runHelper(JSON.stringify({ version: 99, chain: "tron" }));
    const body = JSON.parse(stdout);
    assert.equal(code, 1);
    assert.equal(body.error, "invalid_input");
    assert.match(body.error_description, /Unknown envelope version/);
  });

  it("rejects an envelope without chain", async () => {
    const { stdout, code } = await runHelper(JSON.stringify({ version: 1 }));
    const body = JSON.parse(stdout);
    assert.equal(code, 1);
    assert.equal(body.error, "invalid_input");
    assert.match(body.error_description, /chain is required/);
  });

  it("rejects an unknown chain", async () => {
    const { stdout, code } = await runHelper(
      JSON.stringify({ version: 1, chain: "dogecoin" }),
    );
    const body = JSON.parse(stdout);
    assert.equal(code, 1);
    assert.equal(body.error, "invalid_input");
    assert.match(body.error_description, /Unknown chain/);
  });
});

describe("dispatcher — future-chain branch", () => {
  for (const chain of ["solana", "bitcoin", "litecoin"]) {
    it(`returns chain_not_supported_yet for ${chain}`, async () => {
      const { stdout, code } = await runHelper(JSON.stringify({ version: 1, chain }));
      const body = JSON.parse(stdout);
      assert.equal(code, 1);
      assert.equal(body.ok, false);
      assert.equal(body.chain, chain);
      assert.equal(body.error, "chain_not_supported_yet");
      assert.match(body.error_description, /roadmap/);
    });
  }
});

describe("dispatcher — version + ok envelope shape", () => {
  it("error responses always carry version + ok:false + chain field", async () => {
    const { stdout } = await runHelper(JSON.stringify({ version: 1, chain: "solana" }));
    const body = JSON.parse(stdout);
    assert.equal(body.version, 1);
    assert.equal(body.ok, false);
    assert.equal(body.chain, "solana");
    assert.ok(typeof body.error === "string");
    assert.ok(typeof body.error_description === "string");
  });
});
