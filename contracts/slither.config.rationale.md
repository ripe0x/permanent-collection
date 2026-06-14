# Slither config rationale

`slither.config.json` excludes the detectors below as triaged false-positives
or out-of-audit-scope. Re-enable any of them at audit/review time if the
threat model changes.

Run from `contracts/`:
```bash
slither . --config-file slither.config.json
```

> **Hand-reconciled 2026-06-02.** The `missing-inheritance` and
> `missing-zero-check` entries below were updated by hand to track
> post-rename source identifiers (`flush()`→`sweep()`,
> `BountyAdapter`→`LiveBidAdapter`) and to drop the deleted
> `paySettleReward` / `FinalSaleModule` references. Slither was **not**
> re-run, so the per-detector counts may have drifted — regenerate the live
> output at audit time to confirm.

## Excluded detectors and why

- **`arbitrary-send-eth`** — All flagged calls (`msg.sender.call{value:}`,
  `seller.call{value:}`) are intentional caller-rewards, refunds, or
  payouts to a Punk seller (whose address was validated by a market-state
  check). No path lets an attacker redirect funds to an arbitrary recipient.
- **`timestamp`** — Auction windows are 15 minutes minimum, deadlines are
  72-hour scales, and we grant no probabilistic privileges based on time.
  15-second miner-timestamp drift is irrelevant at this scale.
- **`low-level-calls`** — We use `.call{value:}` deliberately to handle
  recipient-side failures without reverting the protocol-essential work.
  Switching to `transfer`/`send` would re-introduce the 2300-gas-stipend
  griefing vector.
- **`incorrect-equality`** — All `== 0` checks are sentinel-value checks
  where 0 is meaningful (empty queue, unset acquisition, no current bid).
  Not adversarially manipulable.
- **`naming-convention`** — Leading-underscore parameter names
  (`_token`, `_patron`) are deliberate, used to disambiguate setter args
  from state vars. Widely adopted convention.
- **`too-many-digits`** — `CANONICAL_IDS` in the renderer is a packed
  binary blob (`bytes private constant`), not a numeric literal.
- **`uninitialized-local`** — `bytes memory cells;` is correctly
  initialized to empty bytes; Slither's static check misses Solidity's
  zero-init semantics for memory variables.
- **`calls-loop`** — Only flagged in the renderer (out of audit scope —
  view-only, off-chain consumption).
- **`cyclomatic-complexity`** — Three flagged functions (executeStep,
  settle, acceptListing) are each conceptually a single operation with
  branching for parallel concerns. Refactoring would obscure intent
  without reducing risk.
- **`missing-inheritance`** — False positive: the `sweep()` collision across
  `LiveBidAdapter` / `VaultBurnPool` is incidental (each does a different
  thing), not a missing interface relationship.
- **`reentrancy-benign`** / **`reentrancy-events`** — Event emission
  after external calls. Operationally indistinguishable; not exploitable.
  Cross-function reentrancy guards on the actually-load-bearing
  functions (`nonReentrant`) close the real surface.
- **`reentrancy-no-eth`** — `executeStep` updates `remainingEth` after
  `poolManager.unlock`. The unlock callback is gated to
  `msg.sender == poolManager`; the pacing check
  (`lastStepBlock = block.number`) prevents re-entry via a separate
  `executeStep` call in the same block.
- **`redundant-statements`** — `minOut;` and `ok4;` are intentional
  silence-unused-var statements where the value is consumed by
  surrounding logic (abi.decode, ok-or-revert).
- **`divide-before-multiply`** — Maximum precision loss is 1 wei per
  call on the keeper-reward calculation. Refactoring to multiply-first
  would help by ε, but the rounding is in the protocol's favor (caller
  earns slightly less than nominal).
- **`missing-zero-check`** — Two flagged: `acceptBid.seller` is the Punk's
  current owner (read via `punkIndexToAddress`), gated non-zero by the
  `msg.sender == seller` ownership check; `ProtocolAdmin.transferAdmin(0)`
  is the *documented burn pattern*.
- **`unused-return`** — All flagged returns are intentional positional
  discards (`(x,,,) = ...` tuple unpacks) or `try/catch`-wrapped
  best-effort calls where the return is genuinely irrelevant.

## NOT excluded (real findings, addressed in source)

- **`unchecked-transfer`** on `IWETH.transfer` in BuybackBurner —
  **fixed** by wrapping in `require(...)`.
- **`reentrancy-eth`** in `executeStep` failed-reward branch —
  **fixed** by reordering: pre-debit reward before the call, re-credit
  on failure. Now no state writes happen after the external call.
- **`unindexed-event-address`** on `WiringFinalized` — **fixed** by
  indexing the address params on both Patron and PermanentCollection.

## Re-running

To see the full unfiltered output (audit-time):
```bash
slither . --filter-paths "lib/"
```

To verify the curated output is clean:
```bash
slither . --config-file slither.config.json
```
