import { ERROR_KIND, HelperError, mapLedgerError } from "./errors.js";
import { openTransport, closeTransport } from "./transport.js";

/**
 * TRON signing handler.
 *
 * Wire shape (input):
 * ```
 * {
 *   "version": 1,
 *   "chain": "tron",
 *   "path": "m/44'/195'/0'/0/0",
 *   "tx": {
 *     "raw_data_hex": "0a02e3...",
 *     "txID": "abc...",
 *     "expected_from": "TYWHXJ7g9x4H4WF3gCxRf9A7fRL5yWKLhe",
 *     "token_signatures": []
 *   }
 * }
 * ```
 *
 * Wire shape (output):
 * ```
 * {
 *   "version": 1, "ok": true, "chain": "tron",
 *   "result": { "signature_hex": "abc...", "signer_address": "TYWHXJ..." }
 * }
 * ```
 *
 * Two on-device steps fire in sequence:
 *
 *   1. `getAddress(path)` — derives the address client-side and
 *      shows nothing on-device (display=false). Used to confirm
 *      the prepared tx's `from` matches the device's derived
 *      address. **If they disagree, refuse to sign.** This
 *      catches a hostile hosted operator that swapped the
 *      `from` field — the device would still sign but with a
 *      different account than the user reviewed in chat.
 *
 *   2. `signTransaction(path, raw_data_hex, token_signatures)`
 *      — the actual sign call. The Ledger TRON app
 *      clear-signs all standard contract types (TRX transfer,
 *      TRC-20 transfer, freeze/unfreeze, vote, etc.) and shows
 *      the recipient + amount on the device screen. The user
 *      reviews on-device and presses both buttons.
 *
 * The tokenSignatures list is for TRC-10 transfers (the Ledger
 * TRON app needs an extra blob to display the token name); EVERY
 * other transaction type passes an empty array. The hosted MCP
 * supplies the list when needed; the helper just forwards.
 */

/**
 * @param {{
 *   path: string,
 *   tx: {
 *     raw_data_hex: string,
 *     txID?: string,
 *     expected_from?: string,
 *     token_signatures?: string[],
 *   },
 * }} input
 * @param {{
 *   transportFactory?: () => Promise<unknown>,
 *   appFactory?: (transport: unknown) => unknown,
 * }} [deps]
 * @returns {Promise<{ signature_hex: string, signer_address: string }>}
 */
export async function signTron(input, deps = {}) {
  validate(input);

  let transport = null;
  try {
    transport = await openTransport({ factory: deps.transportFactory });
  } catch (e) {
    throw mapLedgerError(e, "openTransport");
  }

  try {
    const app = deps.appFactory
      ? deps.appFactory(transport)
      : await buildDefaultApp(transport);

    // Step 1 — derive the address from the device. `display:false`
    // means the device doesn't prompt for confirmation here; the
    // address is derived without user interaction.
    let derivedAddress;
    try {
      const res = await app.getAddress(input.path, false);
      derivedAddress = res.address;
    } catch (e) {
      throw mapLedgerError(e, "getAddress");
    }

    // Step 2 — refuse to sign if the prepared tx's `from`
    // doesn't match the device-derived address. SECURITY-
    // CRITICAL: this is the helper's primary defense against a
    // hostile hosted operator swapping `from`.
    if (input.tx.expected_from && derivedAddress !== input.tx.expected_from) {
      throw new HelperError(
        ERROR_KIND.ADDRESS_MISMATCH,
        `SECURITY: Ledger device address (${derivedAddress}) does not match the prepared tx's expected_from (${input.tx.expected_from}). ` +
          `Either the wrong Ledger account is selected or the hosted server tampered with the from field. Re-prepare the tx; do not retry blindly.`,
      );
    }

    // Step 3 — actual sign call. The user reviews on-device.
    let signatureHex;
    try {
      signatureHex = await app.signTransaction(
        input.path,
        input.tx.raw_data_hex,
        input.tx.token_signatures ?? [],
      );
    } catch (e) {
      throw mapLedgerError(e, "signTransaction");
    }

    // Sanity-check the signature shape. Ledger's TRON app
    // returns 130 hex chars (65 bytes: r ‖ s ‖ v). Anything else
    // means the device exchange was unhealthy — refuse the
    // result and surface the anomaly.
    if (!/^[0-9a-fA-F]{130}$/.test(signatureHex)) {
      throw new HelperError(
        ERROR_KIND.INTERNAL_ERROR,
        `SECURITY: Ledger returned an unexpected signature shape (length ${signatureHex.length}, expected 130 hex chars). ` +
          `Do NOT broadcast this signature. Disconnect, reconnect the device, reopen the TRON app, and re-prepare from scratch.`,
      );
    }

    return { signature_hex: signatureHex, signer_address: derivedAddress };
  } finally {
    await closeTransport(transport);
  }
}

function validate(input) {
  if (!input || typeof input !== "object") {
    throw new HelperError(ERROR_KIND.INVALID_INPUT, "TRON envelope is not an object.");
  }
  if (typeof input.path !== "string" || !input.path.startsWith("m/44'/195'/")) {
    throw new HelperError(
      ERROR_KIND.INVALID_INPUT,
      `TRON envelope.path must be a BIP44 path under m/44'/195'/, got: ${input.path}`,
    );
  }
  if (
    !input.tx ||
    typeof input.tx.raw_data_hex !== "string" ||
    !/^[0-9a-fA-F]+$/.test(input.tx.raw_data_hex) ||
    input.tx.raw_data_hex.length === 0
  ) {
    throw new HelperError(
      ERROR_KIND.INVALID_INPUT,
      "TRON envelope.tx.raw_data_hex must be a non-empty hex string.",
    );
  }
  if (
    input.tx.token_signatures !== undefined &&
    !Array.isArray(input.tx.token_signatures)
  ) {
    throw new HelperError(
      ERROR_KIND.INVALID_INPUT,
      "TRON envelope.tx.token_signatures, when present, must be an array.",
    );
  }
}

async function buildDefaultApp(transport) {
  const mod = await import("@ledgerhq/hw-app-trx");
  const Trx = mod.default ?? mod;
  return new Trx(transport);
}
