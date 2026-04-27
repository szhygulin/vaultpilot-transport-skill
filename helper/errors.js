/**
 * Structured error kinds returned in the helper's stdout response.
 * Match the table in `SKILL.md` § Parsing the helper's response so
 * the agent can branch on a stable string.
 *
 * Stable across versions; new kinds are added, never renamed.
 */

export const ERROR_KIND = Object.freeze({
  /** User pressed reject on-device. Bytes were never signed. Don't retry without user re-approval. */
  USER_REJECTED: "user_rejected",
  /** USB cable pulled mid-flow, or device locked. Reconnect + unlock + retry. */
  DEVICE_DISCONNECTED: "device_disconnected",
  /** Device is on a different app than required (e.g. dashboard, or wrong chain's app). */
  WRONG_APP: "wrong_app",
  /**
   * The address the device derived from the BIP44 path does NOT match
   * the envelope's `expected_from`. Do NOT retry — re-prepare the tx.
   * This catches a hostile hosted-mode operator that swapped the
   * `from` field.
   */
  ADDRESS_MISMATCH: "address_mismatch",
  /** Helper input was malformed (missing fields, bad shapes, unknown chain). */
  INVALID_INPUT: "invalid_input",
  /** Future-proofing: the envelope says `chain: "x"` but this helper version doesn't know `x`. */
  CHAIN_NOT_SUPPORTED_YET: "chain_not_supported_yet",
  /** Catch-all for unexpected exceptions. File an issue with the description. */
  INTERNAL_ERROR: "internal_error",
});

/**
 * Custom error class so chain handlers can throw with a stable
 * `kind` and the dispatcher in index.js can map to the structured
 * stdout response without inspecting message strings.
 */
export class HelperError extends Error {
  constructor(kind, description) {
    super(description);
    this.name = "HelperError";
    this.kind = kind;
  }
}

/**
 * Translate an underlying transport / app-client error into one of
 * our structured kinds. Ledger libraries throw a few well-known
 * shapes — we pattern-match on `statusCode` (APDU status word) and
 * common substrings.
 */
export function mapLedgerError(err, opName) {
  const message = err && err.message ? String(err.message) : String(err);
  // APDU 0x6985 = user denied on device.
  if (
    err &&
    (err.statusCode === 0x6985 ||
      err.statusText === "CONDITIONS_OF_USE_NOT_SATISFIED" ||
      /denied|rejected|0x6985/i.test(message))
  ) {
    return new HelperError(
      ERROR_KIND.USER_REJECTED,
      `User rejected the transaction on the device during ${opName}.`,
    );
  }
  // APDU 0x6E00 / 0x6D00 = wrong app open (dashboard or different chain).
  if (
    err &&
    (err.statusCode === 0x6e00 ||
      err.statusCode === 0x6d00 ||
      /CLA_NOT_SUPPORTED|INS_NOT_SUPPORTED|0x6e00|0x6d00/i.test(message))
  ) {
    return new HelperError(
      ERROR_KIND.WRONG_APP,
      `The Ledger device is on a different app than required (${opName}). Open the chain-specific app and retry.`,
    );
  }
  // Common transport disconnect surfaces.
  if (
    /disconnected|cannot open device|TransportError|cable|device is busy|HID/i.test(
      message,
    )
  ) {
    return new HelperError(
      ERROR_KIND.DEVICE_DISCONNECTED,
      `Connection to the Ledger was lost during ${opName}: ${message}`,
    );
  }
  return new HelperError(
    ERROR_KIND.INTERNAL_ERROR,
    `Unexpected device error during ${opName}: ${message}`,
  );
}
