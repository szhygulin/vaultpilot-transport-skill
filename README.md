# vaultpilot-transport-skill — agent-side relay skill for hosted vaultpilot-mcp

> **Status: TRON only (initial bootstrap).** Solana / Bitcoin / Litecoin land in follow-up PRs.

A Claude Code skill that brings hardware-wallet signing back to **hosted-mode** [`vaultpilot-mcp`](https://github.com/szhygulin/vaultpilot-mcp). When the hosted MCP returns a `relay_required: "ledger-usb"` envelope (because TRON / Solana / BTC / LTC signing requires direct USB-HID access that the hosted server doesn't have), the agent invokes the helper in this repo, the helper talks to your local Ledger over USB-HID, and the agent posts the signed bytes back to the hosted MCP for broadcast.

EVM signing is **not** routed through this skill — it goes through WalletConnect → Ledger Live → Ledger device, all via the hosted MCP, unchanged.

## Why this repo is separate

Same reasoning as [`vaultpilot-security-skill`](https://github.com/szhygulin/vaultpilot-security-skill) (the agent-side preflight skill): an attacker who compromises the hosted MCP's release pipeline cannot push a change that weakens or removes this skill. The skill's trust root is **your own clone of this repository on your local disk**.

The hosted MCP additionally pins the SHA-256 of `SKILL.md` — on every signing flow it asks the agent to recompute the hash and abort if it doesn't match the pin. Catches:
- Tampered `SKILL.md` on disk (attacker can't change content without changing SHA).
- Plugin-collision where a different skill is registered under the same name (colliding content lacks the in-file integrity sentinel).

## Trust model

The data flow when the agent invokes this helper:

```
hosted MCP            agent (local)            helper (local, this repo)            Ledger device
   │                        │                            │                                │
   │──unsigned envelope────▶│                            │                                │
   │                        │──spawn `node helper/...`──▶│                                │
   │                        │                            │──open USB-HID────▶             │
   │                        │                            │  user reviews on device screen │
   │                        │                            │  user approves (both buttons)  │
   │                        │                            │◀─signed bytes────              │
   │                        │◀──{ ok:true, signature }───│                                │
   │◀──submit_signed_tx─────│                            │                                │
   │  broadcasts via operator RPC                                                          │
```

What each component **can** do:
- **Hosted MCP**: choose the bytes the user is asked to sign. Substitute bytes if it wishes.
- **Agent**: choose whether to call the helper, what to pass it, what to relay back to the hosted MCP.
- **Helper (this repo)**: choose whether to open USB-HID, what bytes to push to the device, what to return to the agent.
- **Ledger device**: shows the user **the actual bytes it will sign**, either clear-signed (decoded as a transaction) or blind-signed (as a SHA-256 hash). Signs only if the user presses both buttons.

What each component **cannot** do:
- **None of them** can forge a signature without the user's hardware wallet.
- **None of them** can change what the device shows the user before signing.
- A byte-substituting hosted operator must forge a SHA-256 collision with the bytes the user reviewed on-device — computationally infeasible.

This is the same trust shape as WalletConnect — the helper is a transport for unsigned/signed bytes, not a signing authority.

**The on-device review is the canonical defense.** Always check the recipient + amount on the Ledger screen, not in the chat.

## Install

```bash
git clone https://github.com/szhygulin/vaultpilot-transport-skill.git \
  ~/.claude/skills/vaultpilot-transport-skill
cd ~/.claude/skills/vaultpilot-transport-skill
npm install
```

Restart Claude Code so the skill is discovered. When the hosted MCP starts and sees `~/.claude/skills/vaultpilot-transport-skill/SKILL.md`, signing flows for TRON (and, in future versions, Solana / BTC / LTC) become available against the hosted endpoint.

### Linux only — Ledger udev rules

On Linux the helper opens a USB-HID device, which requires `LedgerHQ/udev-rules`. If the helper logs `permission denied` while opening the device, run:

```bash
wget -q -O - https://raw.githubusercontent.com/LedgerHQ/udev-rules/master/add_udev_rules.sh | sudo bash
```

Then re-plug the device. macOS and Windows do not need this step.

## Audit

Each release carries:
- An integrity pin (SHA-256 of `SKILL.md`) coordinated with `vaultpilot-mcp`'s `instructions` block.
- An invisible sentinel string inside `SKILL.md` so a colliding skill registered under the same name (where someone replaces the file but happens to keep the SHA — astronomically unlikely but possible with a hash-extension attack on metadata) is still detectable.
- All helper code in `helper/` is plain ESM JavaScript with no build step. `git clone` + `npm install` gives you exactly the bytes that ship.

The dependency surface for TRON signing is:
- `@ledgerhq/hw-transport-node-hid` — USB-HID transport
- `@ledgerhq/hw-app-trx` — Ledger TRON app client

Both maintained by Ledger SAS.

Solana / BTC / LTC will add `@ledgerhq/hw-app-solana`, `@ledgerhq/hw-app-btc`, `bitcoinjs-lib` (for PSBT manipulation) when those chains land.

## Update

```bash
cd ~/.claude/skills/vaultpilot-transport-skill
git pull --ff-only
npm install
```

Diff the new `SKILL.md` against the current one before pulling if you want to audit the change. See `CHANGELOG.md` for per-version notes.

## Wire format (helper ABI)

The helper reads a JSON envelope on stdin and writes a JSON response on stdout. Stable across versions; incompatible changes bump the `version` field.

### Input envelope

```json
{
  "version": 1,
  "chain": "tron",
  "path": "m/44'/195'/0'/0/0",
  "tx": {
    "raw_data_hex": "0a02...",
    "txID": "abc...",
    "expected_from": "TYWHXJ7g9x4H4WF3gCxRf9A7fRL5yWKLhe"
  }
}
```

`expected_from` is the address the hosted MCP claims this transaction is from. The helper derives the address from the device + path and refuses to sign if they don't match — this catches the case where a hostile hosted operator has substituted bytes addressed to a different account.

### Success response

```json
{
  "version": 1,
  "ok": true,
  "chain": "tron",
  "result": {
    "signature_hex": "deadbeef...",
    "signer_address": "TYWHXJ..."
  }
}
```

### Error response

```json
{
  "version": 1,
  "ok": false,
  "chain": "tron",
  "error": "user_rejected" | "device_disconnected" | "wrong_app" | "address_mismatch" | "invalid_input" | "internal_error",
  "error_description": "Human-readable explanation."
}
```

The helper exits 0 on success (`ok: true`) and 1 on error (`ok: false`) so a shell-script caller can branch without parsing JSON.

## Reporting a vulnerability

Open a GitHub security advisory at <https://github.com/szhygulin/vaultpilot-transport-skill/security/advisories/new> rather than a public issue. Include a reproduction, the affected version, and your assessment of impact.
