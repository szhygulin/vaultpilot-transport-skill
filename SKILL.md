<!--
VAULTPILOT-TRANSPORT-SKILL-SENTINEL: do-not-remove
This sentinel + the SHA-256 of the file as a whole is what
hosted vaultpilot-mcp pins to detect tampering. Both must
be present for the integrity check to pass. See
README.md § Audit for the full trust model.
-->

# vaultpilot-transport-skill — relay USB-HID Ledger signing for hosted vaultpilot-mcp

## When this skill applies

Fires whenever a `vaultpilot-mcp` tool response (signing-flow tool: any `prepare_*` or `send_transaction` against a hosted endpoint) contains a `relay_required` envelope of the shape:

```json
{
  "relay_required": "ledger-usb",
  "version": 1,
  "chain": "tron" | "solana" | "bitcoin" | "litecoin",
  "envelope": { /* chain-specific unsigned-bytes */ }
}
```

If you see this on the response of a hosted-mode signing flow, the hosted server has prepared the transaction but cannot reach the user's Ledger over USB. **Your job: invoke the local helper to obtain a signature, then call the hosted MCP back with the signed bytes.**

If the hosted MCP returns `error: "hosted_mode_signing_unavailable"` instead of a `relay_required` envelope, that is the older PR D.0 gate response and means the relay is not yet wired on the hosted side. Tell the user: "Hosted-mode signing for this chain is not yet relay-enabled. Either run vaultpilot-mcp locally (`npm i -g vaultpilot-mcp`) or wait for the hosted operator to enable the relay."

## Per-chain support (today)

| Chain | Status |
|---|---|
| TRON | ✅ Supported (this version) |
| Solana | ⏳ Not yet — return `error: "chain_not_supported_yet"` if attempted |
| Bitcoin | ⏳ Not yet |
| Litecoin | ⏳ Not yet |

EVM chains do **not** route through this skill — they use WalletConnect.

## How to invoke the helper

The helper is a small Node script at `${HOME}/.claude/skills/vaultpilot-transport-skill/helper/index.js`. It reads a JSON envelope on stdin and writes a JSON response on stdout. It opens USB-HID directly to the Ledger device — the user must have the device connected, unlocked, and have the chain-appropriate app open (TRON for TRON, etc.).

**Tell the user before invoking:**

> "Connect your Ledger via USB, unlock it, and open the **TRON** app on the device. The relay helper will prompt the device to sign the transaction shown in the prepare receipt — review the recipient and amount **on the Ledger screen** before pressing both buttons to approve."

Then invoke (Bash):

```bash
echo '{
  "version": 1,
  "chain": "tron",
  "path": "<bip44_path_from_envelope>",
  "tx": <chain_specific_tx_object_from_envelope>
}' | node ~/.claude/skills/vaultpilot-transport-skill/helper/index.js
```

The `path` and `tx` fields come straight from the hosted MCP's `relay_required` envelope. **Do NOT invent or modify them.** If the user has multiple Ledger accounts paired, the path comes from whichever was active at the prepare step (the hosted MCP encodes it in the envelope).

## Parsing the helper's response

```json
{
  "version": 1,
  "ok": true,
  "chain": "tron",
  "result": {
    "signature_hex": "abc...",
    "signer_address": "TYWHXJ..."
  }
}
```

If `ok: true`, post back to the hosted MCP via:

```
submit_signed_tx({
  handle: <handle_from_prepare>,
  chain: "tron",
  signature_hex: "<from helper>",
  signer_address: "<from helper>"
})
```

If `ok: false`, **do not retry blindly**. Surface the error verbatim to the user:

| `error` | What it means | What to tell the user |
|---|---|---|
| `user_rejected` | User pressed reject on-device | "You rejected the transaction on the device. The transaction was not signed." |
| `device_disconnected` | USB cable pulled or device locked mid-flow | "Connection to the Ledger was lost. Reconnect and unlock the device, then try again." |
| `wrong_app` | Device is on a different app than required | "Open the TRON app on the device and try again." |
| `address_mismatch` | Device-derived address ≠ envelope's `expected_from` | **Critical.** Tell the user: "The Ledger derived a different address than the prepared transaction's `from` field. Either the wrong device is connected, or the hosted server tampered with the transaction's `from`. **Do not retry.** Re-prepare from scratch and confirm the new envelope's `from` matches your intent." |
| `invalid_input` | Malformed envelope | Likely a bug — file an issue. Don't retry without changes. |
| `internal_error` | Helper crashed | File an issue with the message. |

## Critical: do NOT modify bytes between hosted MCP and helper

The whole trust story rests on the Ledger device showing the user **the actual bytes it will sign**. If the agent modifies the `tx` object before passing to the helper, the device will sign different bytes than what the user sees in chat. The agent's job is **transport, not interpretation**:

- ✅ Pass `envelope.tx` straight from the `relay_required` block to the helper's stdin.
- ✅ Pass the helper's `result.signature_hex` straight to `submit_signed_tx`.
- ❌ Never re-encode, re-decode, re-serialize, or "normalize" any bytes in between.

If the user asks "why does the device show X but the chat showed Y?", the answer is **the device is right** — the chat was prepared by the hosted MCP and may have been tampered. Always trust the device screen over the chat.

## What this skill is NOT for

- **EVM signing.** EVM goes through WalletConnect → Ledger Live. If you see a `relay_required` envelope with `chain` ∈ {`ethereum`, `arbitrum`, `polygon`, `base`, …}, that's a hosted MCP bug — file an issue, don't try to fix client-side.
- **Read-only operations.** Read tools (`get_portfolio_summary`, `get_token_balance`, etc.) never produce `relay_required` envelopes — they don't sign anything.
- **Local-mode (`npm i -g`) signing.** When `vaultpilot-mcp` runs locally as a stdio child of Claude Code, it talks to USB-HID directly — no relay, no skill invocation needed.
