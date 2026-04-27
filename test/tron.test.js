/**
 * Tests for `helper/tron.js` against a mocked Ledger TRON app.
 * No real device, no network — pure logic + the device-call
 * sequence. Validates:
 *
 *   - input validation (path shape, raw_data_hex shape)
 *   - getAddress → expected_from match: signs
 *   - getAddress → expected_from mismatch: throws ADDRESS_MISMATCH
 *   - signTransaction → user rejected: throws USER_REJECTED
 *   - signTransaction → wrong app: throws WRONG_APP
 *   - signTransaction → device disconnected: throws DEVICE_DISCONNECTED
 *   - signTransaction → bad signature shape: throws INTERNAL_ERROR
 *   - happy path returns { signature_hex, signer_address }
 *   - tokenSignatures forwarded as-is
 *   - transport closed even on throw
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { signTron } from "../helper/tron.js";
import { ERROR_KIND, HelperError } from "../helper/errors.js";

const VALID_PATH = "m/44'/195'/0'/0/0";
const VALID_RAW = "0a02e3";
const VALID_ADDRESS = "TYWHXJ7g9x4H4WF3gCxRf9A7fRL5yWKLhe";
const SIG_130 = "a".repeat(130);

function makeMocks(overrides = {}) {
  const closes = [];
  const transport = {
    close: async () => {
      closes.push(Date.now());
    },
  };
  const app = {
    getAddress: overrides.getAddress ?? (async () => ({ address: VALID_ADDRESS, publicKey: "deadbeef" })),
    signTransaction: overrides.signTransaction ?? (async () => SIG_130),
  };
  return {
    closes,
    deps: {
      transportFactory: async () => transport,
      appFactory: () => app,
    },
  };
}

describe("signTron — input validation", () => {
  it("rejects null input", async () => {
    await assert.rejects(
      signTron(null),
      (err) => err instanceof HelperError && err.kind === ERROR_KIND.INVALID_INPUT,
    );
  });

  it("rejects path outside m/44'/195'", async () => {
    await assert.rejects(
      signTron({ path: "m/44'/501'/0'/0/0", tx: { raw_data_hex: VALID_RAW } }),
      (err) => err instanceof HelperError && err.kind === ERROR_KIND.INVALID_INPUT,
    );
  });

  it("rejects empty raw_data_hex", async () => {
    await assert.rejects(
      signTron({ path: VALID_PATH, tx: { raw_data_hex: "" } }),
      (err) => err instanceof HelperError && err.kind === ERROR_KIND.INVALID_INPUT,
    );
  });

  it("rejects non-hex raw_data_hex", async () => {
    await assert.rejects(
      signTron({ path: VALID_PATH, tx: { raw_data_hex: "not-hex" } }),
      (err) => err instanceof HelperError && err.kind === ERROR_KIND.INVALID_INPUT,
    );
  });

  it("rejects token_signatures that isn't an array", async () => {
    await assert.rejects(
      signTron(
        { path: VALID_PATH, tx: { raw_data_hex: VALID_RAW, token_signatures: "nope" } },
      ),
      (err) => err instanceof HelperError && err.kind === ERROR_KIND.INVALID_INPUT,
    );
  });
});

describe("signTron — address-mismatch guard", () => {
  it("refuses to sign when device address doesn't match expected_from", async () => {
    const { deps, closes } = makeMocks();
    await assert.rejects(
      signTron(
        {
          path: VALID_PATH,
          tx: {
            raw_data_hex: VALID_RAW,
            expected_from: "DIFFERENT_ADDRESS_NOT_THE_DEVICE_ONE",
          },
        },
        deps,
      ),
      (err) => err instanceof HelperError && err.kind === ERROR_KIND.ADDRESS_MISMATCH,
    );
    // Transport must close even on the mismatch throw.
    assert.equal(closes.length, 1);
  });

  it("signs when expected_from matches device address", async () => {
    const { deps } = makeMocks();
    const out = await signTron(
      {
        path: VALID_PATH,
        tx: { raw_data_hex: VALID_RAW, expected_from: VALID_ADDRESS },
      },
      deps,
    );
    assert.equal(out.signer_address, VALID_ADDRESS);
    assert.equal(out.signature_hex, SIG_130);
  });

  it("signs when expected_from is omitted (legacy / pre-relay invokers)", async () => {
    const { deps } = makeMocks();
    const out = await signTron(
      { path: VALID_PATH, tx: { raw_data_hex: VALID_RAW } },
      deps,
    );
    assert.equal(out.signer_address, VALID_ADDRESS);
    assert.equal(out.signature_hex, SIG_130);
  });
});

describe("signTron — Ledger error mapping", () => {
  it("maps APDU 0x6985 to USER_REJECTED", async () => {
    const { deps } = makeMocks({
      signTransaction: async () => {
        const err = new Error("user denied 0x6985");
        err.statusCode = 0x6985;
        throw err;
      },
    });
    await assert.rejects(
      signTron({ path: VALID_PATH, tx: { raw_data_hex: VALID_RAW } }, deps),
      (err) => err instanceof HelperError && err.kind === ERROR_KIND.USER_REJECTED,
    );
  });

  it("maps APDU 0x6e00 to WRONG_APP", async () => {
    const { deps } = makeMocks({
      signTransaction: async () => {
        const err = new Error("CLA_NOT_SUPPORTED 0x6e00");
        err.statusCode = 0x6e00;
        throw err;
      },
    });
    await assert.rejects(
      signTron({ path: VALID_PATH, tx: { raw_data_hex: VALID_RAW } }, deps),
      (err) => err instanceof HelperError && err.kind === ERROR_KIND.WRONG_APP,
    );
  });

  it("maps generic 'TransportError' to DEVICE_DISCONNECTED", async () => {
    const { deps } = makeMocks({
      signTransaction: async () => {
        throw new Error("TransportError: cable unplugged");
      },
    });
    await assert.rejects(
      signTron({ path: VALID_PATH, tx: { raw_data_hex: VALID_RAW } }, deps),
      (err) => err instanceof HelperError && err.kind === ERROR_KIND.DEVICE_DISCONNECTED,
    );
  });

  it("maps unknown errors to INTERNAL_ERROR", async () => {
    const { deps } = makeMocks({
      signTransaction: async () => {
        throw new Error("something completely unexpected");
      },
    });
    await assert.rejects(
      signTron({ path: VALID_PATH, tx: { raw_data_hex: VALID_RAW } }, deps),
      (err) => err instanceof HelperError && err.kind === ERROR_KIND.INTERNAL_ERROR,
    );
  });
});

describe("signTron — signature shape sanity check", () => {
  it("refuses signatures that aren't exactly 130 hex chars", async () => {
    const { deps } = makeMocks({
      signTransaction: async () => "abc", // way too short
    });
    await assert.rejects(
      signTron({ path: VALID_PATH, tx: { raw_data_hex: VALID_RAW } }, deps),
      (err) => err instanceof HelperError && err.kind === ERROR_KIND.INTERNAL_ERROR,
    );
  });

  it("accepts a 130-hex-char signature", async () => {
    const { deps } = makeMocks();
    const out = await signTron(
      { path: VALID_PATH, tx: { raw_data_hex: VALID_RAW } },
      deps,
    );
    assert.equal(out.signature_hex.length, 130);
  });
});

describe("signTron — token_signatures forwarding", () => {
  it("forwards an empty array by default", async () => {
    const seen = { tokenSignatures: undefined };
    const { deps } = makeMocks({
      signTransaction: async (path, raw, tokenSigs) => {
        seen.tokenSignatures = tokenSigs;
        return SIG_130;
      },
    });
    await signTron({ path: VALID_PATH, tx: { raw_data_hex: VALID_RAW } }, deps);
    assert.deepEqual(seen.tokenSignatures, []);
  });

  it("forwards token_signatures when provided", async () => {
    const seen = { tokenSignatures: undefined };
    const { deps } = makeMocks({
      signTransaction: async (path, raw, tokenSigs) => {
        seen.tokenSignatures = tokenSigs;
        return SIG_130;
      },
    });
    await signTron(
      {
        path: VALID_PATH,
        tx: { raw_data_hex: VALID_RAW, token_signatures: ["ab", "cd"] },
      },
      deps,
    );
    assert.deepEqual(seen.tokenSignatures, ["ab", "cd"]);
  });
});

describe("signTron — transport lifecycle", () => {
  it("closes the transport even when signing throws", async () => {
    const { deps, closes } = makeMocks({
      signTransaction: async () => {
        throw new Error("synthetic");
      },
    });
    await assert.rejects(
      signTron({ path: VALID_PATH, tx: { raw_data_hex: VALID_RAW } }, deps),
    );
    assert.equal(closes.length, 1);
  });

  it("closes the transport on the happy path", async () => {
    const { deps, closes } = makeMocks();
    await signTron({ path: VALID_PATH, tx: { raw_data_hex: VALID_RAW } }, deps);
    assert.equal(closes.length, 1);
  });
});
