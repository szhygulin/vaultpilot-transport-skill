#!/usr/bin/env node
/**
 * vaultpilot-transport — CLI dispatcher.
 *
 * Reads a JSON envelope on stdin, dispatches by `chain`, writes
 * the structured response on stdout, and exits 0 on `ok: true`
 * or 1 on `ok: false`. Stderr carries human-readable progress
 * lines so the agent can pipe them to the user.
 *
 * Wire ABI is documented in README.md § Wire format and
 * SKILL.md § How to invoke the helper. Stable across versions;
 * the response always carries `version: 1` so future ABI bumps
 * are detectable.
 *
 * Per-chain handlers are imported lazily so a TRON-only call
 * doesn't pay the load cost of the Solana / BTC modules
 * (relevant when those land).
 */
import { ERROR_KIND, HelperError } from "./errors.js";

const PROTOCOL_VERSION = 1;

const SUPPORTED_CHAINS = new Set(["tron"]);
const FUTURE_CHAINS = new Set(["solana", "bitcoin", "litecoin"]);

async function main() {
  let input;
  try {
    input = await readStdinJson();
  } catch (e) {
    return fail(undefined, ERROR_KIND.INVALID_INPUT, `Failed to read stdin as JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!input || typeof input !== "object") {
    return fail(undefined, ERROR_KIND.INVALID_INPUT, "stdin envelope must be a JSON object.");
  }
  if (input.version !== PROTOCOL_VERSION) {
    return fail(
      input.chain,
      ERROR_KIND.INVALID_INPUT,
      `Unknown envelope version ${JSON.stringify(input.version)}. This helper speaks version ${PROTOCOL_VERSION}.`,
    );
  }
  const chain = typeof input.chain === "string" ? input.chain : "";
  if (!chain) {
    return fail(undefined, ERROR_KIND.INVALID_INPUT, "envelope.chain is required.");
  }
  if (FUTURE_CHAINS.has(chain) && !SUPPORTED_CHAINS.has(chain)) {
    return fail(
      chain,
      ERROR_KIND.CHAIN_NOT_SUPPORTED_YET,
      `Chain "${chain}" relay is on the roadmap but not yet implemented in this version. ` +
        `See https://github.com/szhygulin/vaultpilot-transport for status.`,
    );
  }
  if (!SUPPORTED_CHAINS.has(chain)) {
    return fail(chain, ERROR_KIND.INVALID_INPUT, `Unknown chain "${chain}".`);
  }

  // Dispatch.
  try {
    if (chain === "tron") {
      const { signTron } = await import("./tron.js");
      process.stderr.write(`[vaultpilot-transport] signing tron tx via Ledger USB-HID...\n`);
      const result = await signTron({ path: input.path, tx: input.tx });
      return succeed(chain, result);
    }
    // Unreachable — SUPPORTED_CHAINS gate above covers it.
    return fail(chain, ERROR_KIND.INTERNAL_ERROR, `dispatcher missed chain "${chain}"`);
  } catch (e) {
    if (e instanceof HelperError) {
      return fail(chain, e.kind, e.message);
    }
    return fail(
      chain,
      ERROR_KIND.INTERNAL_ERROR,
      `Unexpected exception: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * @param {string | undefined} chain
 * @param {Record<string, unknown>} result
 */
function succeed(chain, result) {
  process.stdout.write(
    JSON.stringify({
      version: PROTOCOL_VERSION,
      ok: true,
      chain,
      result,
    }) + "\n",
  );
  process.exit(0);
}

/**
 * @param {string | undefined} chain
 * @param {string} kind
 * @param {string} description
 */
function fail(chain, kind, description) {
  process.stdout.write(
    JSON.stringify({
      version: PROTOCOL_VERSION,
      ok: false,
      chain: chain ?? null,
      error: kind,
      error_description: description,
    }) + "\n",
  );
  process.exit(1);
}

/**
 * Read stdin to EOF, parse as JSON. Throws on parse failure;
 * caller wraps with the structured `invalid_input` error.
 */
async function readStdinJson() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return JSON.parse(data);
}

// Test runners that import this file should NOT run main(). The
// `node:test` runner imports modules without side effects when
// the import is part of a test file; we still gate on the
// "is this the entry point" check via `import.meta` so test
// imports are safe.
const isEntryPoint =
  import.meta.url === `file://${process.argv[1]}` ||
  // Fallback for Node < 20.6 where import.meta.url normalizes
  // differently against argv[1].
  process.argv[1]?.endsWith("helper/index.js");

if (isEntryPoint) {
  main().catch((e) => {
    // Belt-and-suspenders: any uncaught throw becomes a structured
    // internal_error. Should be unreachable because main() catches.
    process.stdout.write(
      JSON.stringify({
        version: PROTOCOL_VERSION,
        ok: false,
        chain: null,
        error: ERROR_KIND.INTERNAL_ERROR,
        error_description: e instanceof Error ? e.message : String(e),
      }) + "\n",
    );
    process.exit(1);
  });
}

// Test seam: re-export `main` so a unit test can invoke it
// against a piped stdin without spawning a subprocess. The
// runtime pulls the entry-point gate above so production
// invocations work normally.
export { main };
