# Prose supplement format

Hand-authored content that `scripts/generate-docs.ts` merges with the checked-in
ABIs (`app/lib/abis/*.json`) and `contracts/deployments.mainnet.json` to produce
the final reference pages in `docs/reference/`. The generator is the enforcement
layer: signatures, parameter lists, event topics, and error lists always come
from the ABI; these files carry only the prose.

One file per contract: `docs/reference/_prose/<ContractName>.md`.

## File shape

```markdown
---
contract: Patron
slug: patron
deploymentsKey: patron
title: Patron
---

# summary

One to three paragraphs. What the contract is, what it holds, how it fits the
protocol loop.

# concepts

Optional. Longer explanatory sections. May contain `###` subheadings, tables,
and code blocks. Omit the whole section if the summary says it all.

## function acceptBid

access: permissionless

Behavior prose. What happens step by step, what reverts and why, gotchas.
May contain fenced code examples (```solidity, ```ts, ```bash).

## function bidBalance

One-line (or longer) description. View functions need no `access:` line.

## receive

access: adapter-only

Prose for the receive() function, when the contract has one.

## event BidAccepted

When it is emitted and what an indexer should read from it.

## error ListingExceedsBid

The condition that raises it and what the caller should do about it.
Keep error prose to one or two sentences.
```

## Rules the generator enforces

- Every ABI entry must have a block: `## function <name>`, `## event <name>`,
  `## error <name>`. Missing blocks fail the build with a list of gaps.
- Block names must match the ABI. Unknown names fail the build (catches typos
  and stale prose).
- Overloaded names must be disambiguated with the parameter types:
  `## function tokenURI(uint256)`.
- Every `nonpayable`/`payable` function block must start with an `access:` line.
  Free text, but lead with one of: `permissionless`, `<role>-only`,
  `owner-only`, `deployer one-shot`, and say what the gate is.
- `{{addr:<deploymentsKey>}}` anywhere in prose is replaced with the mainnet
  address from `contracts/deployments.mainnet.json`.

## Style

- Mechanically precise. No investment framing, no dramatic finality. Approved
  terms: live bid, return auction, accepted Punk, eligible Punk, vaulted,
  permanent trait, official pool, Vault Title. Avoid deprecated terms (bounty,
  rescue, trial, hunter, locked away, captured, yield, floor support) in prose;
  contract identifiers like `bountyBps` stay verbatim in code and signatures.
- Describe current state only. No history ("was removed", "replaced X"), no
  PR/audit/issue references.
- Numbers, durations, splits, and addresses come from code, the ABI, or
  `deployments.mainnet.json`, never from memory of other docs.
- No em-dashes. Bullets don't end with periods. Contractions are fine.
- The token is written `$111` in prose, `111` only in identifiers and metadata.
- Address and transaction links use evm.now:
  `https://evm.now/address/<addr>?chainId=1`, `https://evm.now/tx/<hash>?chainId=1`.
- Live-read examples use cast against a free public RPC:
  `cast call {{addr:patron}} "bidBalance()(uint256)" --rpc-url https://ethereum-rpc.publicnode.com`.
- TypeScript examples use viem and may import ABIs as
  `import {abi} from '@/lib/abis/Patron'` or fetch `/abis/Patron.json`.

## Ordering

Write-function blocks render in the order they appear in this file, so put the
main entry points first. Read functions, events, and errors render
alphabetically regardless of file order.
