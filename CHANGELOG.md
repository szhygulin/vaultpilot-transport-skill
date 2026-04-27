# Changelog

## 0.1.0 — initial release (TRON only)

Bootstraps the relay skill for hosted-mode `vaultpilot-mcp`.

- `SKILL.md` — Claude Code skill instructions describing when to fire and how to invoke the helper.
- `helper/index.js` — CLI dispatcher reading JSON envelopes on stdin, dispatching by `chain`.
- `helper/transport.js` — USB-HID transport wrapper with structured error mapping (user-rejected, disconnected, wrong-app).
- `helper/tron.js` — TRON signing implementation. Derives the device address from the path, refuses to sign if it disagrees with the envelope's `expected_from`, returns the 65-byte (r ‖ s ‖ v) signature on success.
- Mocked-USB tests via `node:test`.

Solana, Bitcoin, and Litecoin support is staged for follow-up versions.
