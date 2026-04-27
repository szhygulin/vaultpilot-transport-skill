/**
 * USB-HID transport wrapper. Thin layer over
 * `@ledgerhq/hw-transport-node-hid` that:
 *
 *   - opens the first connected Ledger device (most users have
 *     exactly one plugged in).
 *   - normalizes the close path so it never throws (closing a
 *     disconnected device returns a benign error from the
 *     library that we must not bubble up).
 *
 * Test seam: `openTransport` accepts an optional factory so
 * tests pass a mock transport without monkey-patching the
 * Ledger module. Production calls omit the factory and get the
 * real `TransportNodeHid.create()`.
 */

/**
 * @typedef {object} LedgerTransport
 * @property {() => Promise<void>} close
 */

/**
 * @param {{ factory?: () => Promise<LedgerTransport> }} [opts]
 * @returns {Promise<LedgerTransport>}
 */
export async function openTransport(opts = {}) {
  if (opts.factory) return opts.factory();
  // Dynamic import so tests that mock the module still work.
  // @ledgerhq/hw-transport-node-hid is CommonJS with a default
  // export.
  const mod = await import("@ledgerhq/hw-transport-node-hid");
  const TransportNodeHid = mod.default ?? mod;
  return TransportNodeHid.create();
}

/**
 * Best-effort close. The Ledger library throws on
 * already-closed transports; we swallow because the helper's
 * top-level `finally` calls this and we don't want it to
 * mask the real error from the signing path.
 *
 * @param {LedgerTransport | null | undefined} transport
 */
export async function closeTransport(transport) {
  if (!transport) return;
  try {
    await transport.close();
  } catch {
    // Intentional swallow.
  }
}
