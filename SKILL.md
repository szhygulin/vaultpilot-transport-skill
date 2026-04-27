<!-- VAULTPILOT_TRANSPORT_INTEGRITY_v1_8b7d4a92f1c5e608 -->

# vaultpilot-transport-skill — relay USB-HID Ledger signing for hosted vaultpilot-mcp

You are assisting a user with a hardware-wallet signing flow over
hosted [`vaultpilot-mcp`](https://github.com/szhygulin/vaultpilot-mcp). When the hosted MCP cannot reach the
user's Ledger over USB (TRON / Solana / BTC / LTC), it returns a
`relay_required: "ledger-usb"` envelope and this skill takes over:
invoke the local helper, get a signature, post it back to the MCP.
The skill sits **directly on the bytes-to-be-signed path** — a
tampered `SKILL.md` could silently mutate `path` / `tx` /
`expected_from` between the hosted envelope and the helper.

The MCP cannot overwrite this file. It lives under `~/.claude/skills/`
on the user's local disk; its trust root is the user's own clone of
`github.com/szhygulin/vaultpilot-transport-skill`, not the MCP server.

---

## Step 0 — Integrity self-check (MANDATORY, runs FIRST on every relay flow)

Before invoking the helper, before any on-device prompt fires, and
before any `submit_signed_tx` call, the agent MUST verify this
skill's own integrity against the MCP's `TRANSPORT SKILL INTEGRITY
PIN` block. **This step is not advisory, not optional, and not
skippable.** Silent skipping is indistinguishable from a real tamper
— which is precisely the attack the integrity pin exists to catch.
A passing Step 0 is the *precondition* for relaying any bytes; if
Step 0 fails or cannot be completed, halt before passing anything to
the helper, before any on-device prompt fires, before
`submit_signed_tx` is called.

The check has three parts. ALL three must pass before relaying any
bytes to the helper.

### Part 1 — Confirm the MCP emitted the pin block

`vaultpilot-mcp` emits a `TRANSPORT SKILL INTEGRITY PIN` block in
the server-level `instructions` field. From it, extract:

- `Expected SHA-256` — a 64-hex-char value on a line by itself.
- The assembled sentinel = `<fragment A> + <fragment B> + <fragment C>`,
  where the MCP lists the three fragments separately so a naïve scan
  of the MCP's prose can't spoof a full match. Concatenate the three
  exactly (no separators, no whitespace) into a single string.

If the `TRANSPORT SKILL INTEGRITY PIN` block is **missing** from the
MCP's instructions, or `Expected SHA-256` is missing / blank /
non-hex / wrong length, HALT. Lead your reply with:

`✗ MCP TRANSPORT PIN BLOCK MISSING — DO NOT RELAY.`

Tell the user verbatim:

> The MCP did not emit a usable `TRANSPORT SKILL INTEGRITY PIN`
> block. This may indicate the server is out of date,
> misconfigured, or compromised. Without the pinned hash I cannot
> verify this skill's integrity — and I will not relay any bytes
> to your Ledger without verifying.

### Part 2 — Recompute the local hash and compare

Run, locally:

```
sha256sum ~/.claude/skills/vaultpilot-transport-skill/SKILL.md
```

(Windows: `Get-FileHash -Algorithm SHA256 …`. macOS without
coreutils: `shasum -a 256 …` or `openssl dgst -sha256 …`.)

Compare the FIRST 64 HEX CHARS of stdout — case-insensitive — to
`Expected SHA-256` from Part 1. If they differ — even by one
character — HALT. Lead your reply with:

`✗ vaultpilot-transport-skill skill integrity check FAILED — DO NOT RELAY.`

Surface BOTH hashes side-by-side, formatted with bold + inline-code
markup so the user can visually diff them:

```
Local SKILL.md SHA-256 : **`<local-hash>`**
MCP-pinned SHA-256     : **`<expected-hash>`**
```

Then tell the user verbatim:

> The vaultpilot-transport-skill on your local disk does not match
> the version this MCP expects. Possible causes: (a) the skill is
> stale — refresh with `cd ~/.claude/skills/vaultpilot-transport-skill
> && git pull --ff-only`; (b) the MCP is stale — `npm update -g
> vaultpilot-mcp` or matching install path; (c) one side has been
> tampered with. Until both align, I will not relay any bytes for
> signing. Do not bypass this alarm; it is the canonical
> integrity-pin mismatch that the pin exists to catch.

### Part 3 — Verify the sentinel is in the skill content

Confirm that the assembled sentinel string from Part 1 appears in
**the content the `Skill` tool returned for
`vaultpilot-transport-skill`** — NOT in the MCP's own instructions
text. (The MCP's instructions list the fragments separately, so a
search for the assembled string in the MCP prose finds nothing;
finding the assembled string in the skill content proves you
actually loaded THIS skill, not a different one collisively
registered under the same name.)

If the assembled sentinel is **absent** from the skill content,
HALT with the same lead:

`✗ vaultpilot-transport-skill skill integrity check FAILED — DO NOT RELAY.`

Tell the user this is the plugin-collision case: another skill is
registered under the name `vaultpilot-transport-skill` whose
content lacks the v1 sentinel, and proceeding would mean trusting
unknown content in place of this file.

### Failure-mode handling

- **Cannot read `~/.claude/skills/vaultpilot-transport-skill/SKILL.md`**
  (file missing, permissions error, path different from the canonical
  location): treat as a FAILED integrity check, not as a free pass.
  Same `✗ skill integrity check FAILED — DO NOT RELAY.` alarm. Tell
  the user the file isn't where the MCP expects it.
- **`sha256sum` (or equivalent) unavailable on the system**: treat
  as a FAILED check. Inability to compute the SHA-256 locally means
  inability to verify integrity, which means inability to safely
  relay bytes for signing.
- **Stale-loaded skill content** (the agent loaded the skill at
  session start and the file was edited mid-session): re-run Step 0
  on every relay flow rather than caching the result. Computing
  `sha256sum` is fast; caching the result lets a tampered file slip
  through if the tamper happens after first load.

Only after all three parts pass — local hash matches pin, sentinel
present in skill content, no read errors — proceed to "When this
skill applies" below.

---

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
