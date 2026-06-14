/**
 * Anvil seed helpers for e2e specs.
 *
 * Phase 1 only uses `topUpPatron` (to give the smoke test a non-zero
 * live-bid value to render). The rest of these helpers — impersonation,
 * transferring Punks to the test EOA, allowlisting sellers, advancing
 * time — are needed by Phase 2's specs (`acceptBid.spec.ts`, etc.) and
 * are shipped now so the surface lives next to the fixtures they belong
 * with rather than getting tacked on later.
 *
 * Patterns mirror `scripts/seed-fork.ts`:
 *   • Impersonate via anvil_impersonateAccount, top up gas with
 *     anvil_setBalance.
 *   • Use viem walletClient with `account` set to the impersonated
 *     address; anvil signs server-side.
 *   • Use the standalone CryptoPunks market ABI (the 2017 contract
 *     isn't ERC721, so its API is its own).
 */

import {createPublicClient, createWalletClient, http, parseAbi, parseEther} from 'viem';
import type {Address} from 'viem';
import {anvilRpcUrl, E2E_ENV} from './env';

const PUNKS_MARKET = '0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB' as const;
const PUNKS_DATA = '0x9cF9C8eA737A7d5157d3F4282aCe30880a7A117C' as const;

const MARKET_ABI = parseAbi([
    'function punkIndexToAddress(uint256) view returns (address)',
    'function transferPunk(address, uint256)',
    'function offerPunkForSale(uint256, uint256)',
    'function offerPunkForSaleToAddress(uint256, uint256, address)',
    'function punkBids(uint256) view returns (bool, uint256, address, uint256)',
    'function pendingWithdrawals(address) view returns (uint256)',
]);

const PUNKS_DATA_ABI = parseAbi([
    'function traitMaskOf(uint16) view returns (uint256)',
    'function traitName(uint16) view returns (string)',
]);

const PATRON_ABI = parseAbi([
    'function addAllowedSeller(address)',
    'function bidBalance() view returns (uint256)',
    'function liveBidAdapter() view returns (address)',
    'function acceptBid(uint16, uint8, uint256)',
]);

const PROTOCOL_ADMIN_ABI = parseAbi(['function admin() view returns (address)']);

interface SeedClients {
    pub: ReturnType<typeof createPublicClient>;
}

function makeClients(): SeedClients {
    const transport = http(anvilRpcUrl());
    return {pub: createPublicClient({transport})};
}

/** Impersonate an address + top it up to 1 ETH if it's below that
 *  threshold. Pattern from start-dev-fork.sh's `impersonate_call`. */
export async function impersonate(addr: Address): Promise<void> {
    const {pub} = makeClients();
    const bal = (await pub.request({
        method: 'eth_getBalance' as never,
        params: [addr, 'latest'],
    } as never)) as `0x${string}`;
    const ONE_ETH = 0xde0b6b3a7640000n;
    if (BigInt(bal) < ONE_ETH) {
        await pub.request({
            method: 'anvil_setBalance' as never,
            params: [addr, '0xde0b6b3a7640000'],
        } as never);
    }
    await pub.request({
        method: 'anvil_impersonateAccount' as never,
        params: [addr],
    } as never);
}

/** Stop impersonating. */
export async function stopImpersonating(addr: Address): Promise<void> {
    const {pub} = makeClients();
    await pub.request({
        method: 'anvil_stopImpersonatingAccount' as never,
        params: [addr],
    } as never);
}

/** Fund the live bid the production way: route ETH through the
 *  `LiveBidAdapter` so `Patron.receive()` credits `accountedLiveBidWei`. A raw
 *  `anvil_setBalance` on Patron raises its balance only (forced ETH), which the
 *  accounting EXCLUDES from the live bid — so `acceptBid` would revert
 *  `PayoutBelowMin`. Tops the accounted bid UP to `ethAmount` and is idempotent
 *  when already at/above it (the accounted bid can only be reduced by an
 *  acquisition, never by this helper). */
export async function topUpPatron(patron: Address, ethAmount: string): Promise<void> {
    const {pub} = makeClients();
    const target = parseEther(ethAmount);
    const current = (await pub.readContract({
        address: patron,
        abi: PATRON_ABI,
        functionName: 'bidBalance',
    })) as bigint;
    if (current >= target) return;
    const delta = target - current;

    const adapter = (await pub.readContract({
        address: patron,
        abi: PATRON_ABI,
        functionName: 'liveBidAdapter',
    })) as Address;

    // Give the adapter enough ETH to forward `delta` (+ a gas buffer), then
    // impersonate it and send `delta` to Patron, hitting the adapter-only
    // `receive()` that credits the accounted bid. Restore the adapter's balance
    // afterward so funding leaves NO pending buffer behind — a leftover buffer
    // would trip `streamForward` on the next swap and start the adapter's sweep
    // rate-cap cooldown, which would break the sweep e2e spec.
    const adapterBalBefore = await pub.getBalance({address: adapter});
    const fundWei = delta + parseEther('1');
    await pub.request({
        method: 'anvil_setBalance' as never,
        params: [adapter, '0x' + fundWei.toString(16)],
    } as never);
    await impersonate(adapter);
    try {
        const wallet = createWalletClient({
            account: adapter,
            transport: http(anvilRpcUrl()),
        });
        const hash = await wallet.sendTransaction({chain: null, to: patron, value: delta});
        await pub.waitForTransactionReceipt({hash});
    } finally {
        await stopImpersonating(adapter);
        await pub.request({
            method: 'anvil_setBalance' as never,
            params: [adapter, '0x' + adapterBalBefore.toString(16)],
        } as never);
    }
}

/** Transfer a Punk from its current mainnet owner to `recipient`, by
 *  impersonating the owner and calling `transferPunk`. Used to give
 *  the test EOA a Punk it owns for the acceptBid flow. */
export async function transferPunkToRecipient(
    punkId: number,
    recipient: Address,
): Promise<void> {
    const {pub} = makeClients();
    const owner = (await pub.readContract({
        address: PUNKS_MARKET,
        abi: MARKET_ABI,
        functionName: 'punkIndexToAddress',
        args: [BigInt(punkId)],
    })) as Address;
    if (owner === '0x0000000000000000000000000000000000000000') {
        throw new Error(`e2e seed: punk #${punkId} has no owner on-chain`);
    }
    await impersonate(owner);
    try {
        const wallet = createWalletClient({
            account: owner,
            transport: http(anvilRpcUrl()),
        });
        const hash = await wallet.writeContract({
            chain: null,
            address: PUNKS_MARKET,
            abi: MARKET_ABI,
            functionName: 'transferPunk',
            args: [recipient, BigInt(punkId)],
        });
        await pub.waitForTransactionReceipt({hash});
    } finally {
        await stopImpersonating(owner);
    }
}

/** Pre-list a Punk EXCLUSIVELY to Patron at the current live bid — the staging
 *  step the `acceptBid` flow performs as part of its EIP-5792 bundle. The
 *  protocol buys the listing via `buyPunk`, so the listed price has to be a real
 *  price within 1% of the live bid; listing at exactly `bidBalance()` satisfies
 *  that. Tests that exercise the "already pre-listed" branch use this directly. */
export async function preListToPatron(
    punkId: number,
    owner: Address,
    patron: Address,
): Promise<void> {
    const {pub} = makeClients();
    const listingWei = (await pub.readContract({
        address: patron,
        abi: PATRON_ABI,
        functionName: 'bidBalance',
    })) as bigint;
    await impersonate(owner);
    try {
        const wallet = createWalletClient({
            account: owner,
            transport: http(anvilRpcUrl()),
        });
        const hash = await wallet.writeContract({
            chain: null,
            address: PUNKS_MARKET,
            abi: MARKET_ABI,
            functionName: 'offerPunkForSaleToAddress',
            args: [BigInt(punkId), listingWei, patron],
        });
        await pub.waitForTransactionReceipt({hash});
    } finally {
        await stopImpersonating(owner);
    }
}

/** Allowlist a seller on Patron. Mirrors the carve-out documented in
 *  CLAUDE.md: `addAllowedSeller` bypasses the admin's 1y lock check by
 *  reading `adminContract.admin()` directly. */
export async function allowlistSeller(
    patron: Address,
    protocolAdmin: Address,
    seller: Address,
): Promise<void> {
    const {pub} = makeClients();
    const admin = (await pub.readContract({
        address: protocolAdmin,
        abi: PROTOCOL_ADMIN_ABI,
        functionName: 'admin',
    })) as Address;
    await impersonate(admin);
    try {
        const wallet = createWalletClient({
            account: admin,
            transport: http(anvilRpcUrl()),
        });
        const hash = await wallet.writeContract({
            chain: null,
            address: patron,
            abi: PATRON_ABI,
            functionName: 'addAllowedSeller',
            args: [seller],
        });
        await pub.waitForTransactionReceipt({hash});
    } finally {
        await stopImpersonating(admin);
    }
}

/** Advance the fork's wall clock by `seconds` and mine a block — needed
 *  by allowlist-activation-delay tests (24h) and return-auction-deadline
 *  tests (72h). Mirrors start-dev-fork.sh's MEV-window warp. */
export async function advanceTime(seconds: number): Promise<void> {
    const {pub} = makeClients();
    await pub.request({
        method: 'evm_increaseTime' as never,
        params: [seconds],
    } as never);
    await pub.request({
        method: 'evm_mine' as never,
        params: [],
    } as never);
}

/** Remove any contract/delegation code at `addr` (anvil's `setCode` to empty).
 *
 *  Why this exists: the fork's anvil default accounts (#0..#9) are seeded from
 *  REAL mainnet state at the pinned block, and those well-known addresses carry
 *  an EIP-7702 delegation on mainnet (their code is `0xef0100…<delegate>`, a
 *  7702 delegation indicator someone set on-chain). A delegated EOA is no longer
 *  a "plain" account: when a contract pays it with a gas-limited `.transfer`
 *  (2300 gas) — exactly what the 2017 CryptoPunks market's `withdraw()` does to
 *  pay the seller — the EVM invokes the EOA's delegated code, which here hits an
 *  INVALID (0xFE) opcode and reverts the whole `withdraw()` with
 *  `InvalidFEOpcode`. That breaks the Claim step of the acceptBid flow even
 *  though the wallet, the app, and the contracts are all correct (a real wallet
 *  on a clean EOA has no such delegation). Clearing the code restores the
 *  account to a plain payable EOA so `.transfer` succeeds. Idempotent. */
export async function clearAccountCode(addr: Address): Promise<void> {
    const {pub} = makeClients();
    await pub.request({
        method: 'anvil_setCode' as never,
        params: [addr, '0x'],
    } as never);
}

/** Set raw code at `addr` (anvil's `setCode`). The inverse of
 *  `clearAccountCode`. Used to simulate a smart-contract / delegated seller so
 *  the acceptBid flow's "your wallet may not be able to collect" warning and
 *  its claim-failure recovery path can be exercised from the UI. */
export async function setAccountCode(addr: Address, code: `0x${string}`): Promise<void> {
    const {pub} = makeClients();
    await pub.request({
        method: 'anvil_setCode' as never,
        params: [addr, code],
    } as never);
}

/** Mark `addr` as an EIP-7702-delegated account by writing the
 *  `0xef0100<delegate>` designator. The delegate address is arbitrary here —
 *  the UI's warning keys on the account HAVING delegation code, not on what the
 *  delegate does — so this is enough to surface the early warning. For a
 *  delegation that also makes `withdraw()` revert (the claim-recovery path), use
 *  `delegateToRevertingCode`. */
export async function delegateAccount(addr: Address, delegate: Address): Promise<void> {
    await setAccountCode(addr, `0xef0100${delegate.slice(2)}` as `0x${string}`);
}

/** Faithfully reproduce the mainnet state where a 7702-delegated seller can't
 *  be paid: point `addr`'s delegation at a delegate whose code is a single
 *  INVALID (0xFE) opcode, so the market's 2300-gas `withdraw()` transfer into
 *  the seller reverts with `InvalidFEOpcode` — exactly the failure the forked
 *  default accounts hit. The seller can still ORIGINATE txs (list / accept);
 *  only an inbound value transfer into it reverts. */
export async function delegateToRevertingCode(addr: Address): Promise<void> {
    const delegate = '0x00000000000000000000000000000000000Dead7' as Address;
    await setAccountCode(delegate, '0xfe'); // INVALID opcode — reverts any call into it
    await delegateAccount(addr, delegate);
}

/** Convenience: pre-fund the test EOA with extra ETH on top of anvil's
 *  default 10000. Phase 2 tests that need to place high-value bids on
 *  the return auction (>1000 ETH per call) may need this. */
export async function fundTestEoa(extraEth: string): Promise<void> {
    const {pub} = makeClients();
    const wei = parseEther(extraEth);
    const target = wei + parseEther('10000');
    await pub.request({
        method: 'anvil_setBalance' as never,
        params: [E2E_ENV.testAccount.address, '0x' + target.toString(16)],
    } as never);
}

/** Read a Punk's trait mask from the canonical PunksData contract. Used by
 *  the race-seed test to discover a trait bit two Punks share. */
export async function getPunkTraitMask(punkId: number): Promise<bigint> {
    const {pub} = makeClients();
    return (await pub.readContract({
        address: PUNKS_DATA,
        abi: PUNKS_DATA_ABI,
        functionName: 'traitMaskOf',
        args: [punkId],
    })) as bigint;
}

/** Find the lowest trait bit (0..110) set in BOTH masks. Returns null if
 *  the two Punks share no trait. */
export function firstSharedTraitBit(maskA: bigint, maskB: bigint): number | null {
    const shared = maskA & maskB;
    if (shared === 0n) return null;
    for (let i = 0; i < 111; i++) {
        if ((shared >> BigInt(i)) & 1n) return i;
    }
    return null;
}

const PC_READ_ABI = parseAbi([
    'function collectedMask() view returns (uint256)',
    'function pendingMask() view returns (uint256)',
]);

/** Mirror of AcceptBidFlow's `pickableBits` computation: bits set in
 *  `punkMask` that are neither collected nor pending on the live PC.
 *  Returned sorted ascending. Used by specs to determine which trait
 *  the React picker will actually offer at the moment the spec runs
 *  (prior tests may have flipped bits to pending). */
export async function computePickableBits(
    pcAddr: Address,
    punkMask: bigint,
): Promise<number[]> {
    const {pub} = makeClients();
    const [collectedMask, pendingMask] = await Promise.all([
        pub.readContract({
            address: pcAddr,
            abi: PC_READ_ABI,
            functionName: 'collectedMask',
        }) as Promise<bigint>,
        pub.readContract({
            address: pcAddr,
            abi: PC_READ_ABI,
            functionName: 'pendingMask',
        }) as Promise<bigint>,
    ]);
    const blocked = collectedMask | pendingMask;
    const out: number[] = [];
    for (let i = 0; i < 111; i++) {
        const bit = 1n << BigInt(i);
        if ((punkMask & bit) === 0n) continue;
        if ((blocked & bit) !== 0n) continue;
        out.push(i);
    }
    return out;
}

const PC_TARGET_ABI = parseAbi([
    'function canonicalTargetOf(uint16) view returns (uint8)',
]);

/** Read the protocol-derived target for a Punk straight off the deployed
 *  `PermanentCollection.canonicalTargetOf` — the rarest uncollected,
 *  non-pending trait the Punk carries (ties → lowest bit). This is THE
 *  authority `acceptBid` / `acceptListing` check against (they revert
 *  `NotCanonicalTarget` / `TargetNotCanonical` for anything else), and the
 *  exact value the Punk-first UI derives and shows read-only, so specs read
 *  it here rather than hardcoding a trait. Returns `null` when the Punk has
 *  no eligible target left (the contract reverts `NoEligibleTarget`); specs
 *  treat that as a fail-loud precondition. */
export async function canonicalTargetOf(
    pcAddr: Address,
    punkId: number,
): Promise<number | null> {
    const {pub} = makeClients();
    try {
        const t = (await pub.readContract({
            address: pcAddr,
            abi: PC_TARGET_ABI,
            functionName: 'canonicalTargetOf',
            args: [punkId],
        })) as number;
        return Number(t);
    } catch {
        // NoEligibleTarget (every trait collected/pending) or PunkOutOfRange.
        return null;
    }
}

/** Read each candidate Punk's on-chain owner. Zero-address means the Punk is
 *  held at the canonical market (no EOA owner) and can't be impersonated +
 *  `transferPunk`'d, so it's unusable as a seed/test subject. */
async function ownerOf(punkId: number): Promise<Address> {
    const {pub} = makeClients();
    return (await pub.readContract({
        address: PUNKS_MARKET,
        abi: MARKET_ABI,
        functionName: 'punkIndexToAddress',
        args: [BigInt(punkId)],
    })) as Address;
}

/** A pair of distinct Punks that resolve to the SAME protocol-derived target
 *  under current PC state — the raw material the canonical-target race test
 *  needs (one Punk for the test EOA, one for the racing second account, both
 *  legitimately targeting the same trait so the second's acceptBid makes it
 *  pending and shifts the first's canonical target). */
export interface CanonicalTargetCollision {
    /** Punk the test EOA acquires. */
    punkId: number;
    /** Punk the racing account acquires to consume `target`. */
    seedPunkId: number;
    /** The shared canonical target trait bit. */
    target: number;
}

/** Scan `candidateIds` for two distinct, owned (transferable) Punks whose
 *  `canonicalTargetOf` is the same bit under CURRENT PC state, returning the
 *  first such collision (lowest target bit, then lowest ids). Reading the
 *  contract live — rather than precomputing from the static mask table — keeps
 *  this robust to whatever the shared anvil's `collectedMask` / pending set has
 *  drifted to from prior tests: the canonical target is exactly what the UI
 *  will show and what `acceptBid` will accept at submit time. Fails loud (null)
 *  when no collision exists in the window so the caller can surface a precise
 *  precondition error instead of a downstream UI timeout. */
export async function findCanonicalTargetCollision(
    pcAddr: Address,
    candidateIds: readonly number[],
): Promise<CanonicalTargetCollision | null> {
    // Gather each transferable candidate's live canonical target AND its full
    // set of pickable bits. The pickable count matters for the chosen test
    // Punk: after the shared target is pended, that Punk's canonicalTargetOf
    // must SHIFT to another eligible bit (not revert NoEligibleTarget) for the
    // submit to fail with NotCanonicalTarget — i.e. it needs ≥2 pickable bits.
    interface Cand {
        id: number;
        target: number;
        pickableCount: number;
    }
    const byTarget = new Map<number, Cand[]>();
    for (const id of candidateIds) {
        const owner = await ownerOf(id);
        if (owner === '0x0000000000000000000000000000000000000000') continue;
        const target = await canonicalTargetOf(pcAddr, id);
        if (target === null) continue;
        const mask = await getPunkTraitMask(id);
        const pickableCount = (await computePickableBits(pcAddr, mask)).length;
        const cand: Cand = {id, target, pickableCount};
        const bucket = byTarget.get(target);
        if (bucket) bucket.push(cand);
        else byTarget.set(target, [cand]);
    }
    // Prefer the lowest target bit with ≥2 carriers, lowest ids first, for a
    // deterministic pick across runs. The test Punk must have ≥2 pickable bits
    // (so its target shifts after the race rather than vanishing); the seed
    // Punk has no such requirement (it just needs to legitimately target the
    // shared trait). Pick the test Punk from candidates with ≥2 pickable bits.
    const targets = [...byTarget.keys()].sort((a, b) => a - b);
    for (const target of targets) {
        const cands = byTarget.get(target)!.sort((a, b) => a.id - b.id);
        if (cands.length < 2) continue;
        const testPunk = cands.find((c) => c.pickableCount >= 2);
        if (!testPunk) continue;
        const seed = cands.find((c) => c.id !== testPunk.id);
        if (!seed) continue;
        return {punkId: testPunk.id, seedPunkId: seed.id, target};
    }
    return null;
}

/** Read the canonical trait name for a bit position from PunksData.
 *  Used to address a TraitCard in the picker by its visible label. */
export async function getTraitName(bit: number): Promise<string> {
    const {pub} = makeClients();
    return (await pub.readContract({
        address: PUNKS_DATA,
        abi: PUNKS_DATA_ABI,
        functionName: 'traitName',
        args: [bit],
    })) as string;
}

/** Set an account's raw ETH balance (anvil's `setBalance` cheat). Used
 *  to seed a known starting state on contracts that don't expose a
 *  `receive()` payable path — e.g. directly funding `LiveBidAdapter` to
 *  simulate accumulated swap fees waiting to be swept. */
export async function setBalance(addr: Address, ethAmount: string): Promise<void> {
    const {pub} = makeClients();
    const wei = parseEther(ethAmount);
    await pub.request({
        method: 'anvil_setBalance' as never,
        params: [addr, '0x' + wei.toString(16)],
    } as never);
}

/** Set the value at a specific storage slot via anvil's `setStorageAt`
 *  cheat. Used to bypass slow precondition setup (e.g. setting
 *  PermanentCollection's `collectedMask` to satisfy the TitleAuction's
 *  ≥56-traits-collected threshold without actually vaulting 56 Punks). */
export async function setStorageAt(
    addr: Address,
    slotHex: `0x${string}`,
    valueHex: `0x${string}`,
): Promise<void> {
    const {pub} = makeClients();
    await pub.request({
        method: 'anvil_setStorageAt' as never,
        params: [addr, slotHex, valueHex],
    } as never);
}

/** Set the `block.timestamp` for the next block via `evm_setNextBlockTimestamp`.
 *  Useful when a contract checks `block.timestamp >= activeAt` and the
 *  fork's chain time hasn't progressed past activation; `advanceTime`
 *  also works but requires knowing the relative delta. */
export async function setNextBlockTimestamp(timestampSec: number): Promise<void> {
    const {pub} = makeClients();
    await pub.request({
        method: 'evm_setNextBlockTimestamp' as never,
        params: [timestampSec],
    } as never);
    await pub.request({
        method: 'evm_mine' as never,
        params: [],
    } as never);
}

const REFERRAL_PAYOUT_ABI = parseAbi([
    'function notify(address) payable',
    'function balances(address) view returns (uint256)',
]);

/** Seed a referrer's claimable balance on ReferralPayout by impersonating
 *  the hook (the only authorized caller of `notify`) and forwarding ETH.
 *  Used by the referralClaim spec to put a non-zero balance into the
 *  ledger without running a real swap (which would require the
 *  acquisition gate to be open and a Punk to have been acquired). */
export async function seedReferralBalance(
    referralPayout: Address,
    hook: Address,
    referrer: Address,
    ethAmount: string,
): Promise<void> {
    const {pub} = makeClients();
    const wei = parseEther(ethAmount);
    // The hook may have a smart-contract body that can't be impersonated
    // via anvil's normal flow (impersonation works on EOAs and contracts
    // alike, but the contract's code at the call site may interfere with
    // a synthetic call). Top up the hook's balance first so its
    // `notify{value: …}` has the wei to forward.
    await setBalance(hook, '100');
    await impersonate(hook);
    try {
        const wallet = createWalletClient({
            account: hook,
            transport: http(anvilRpcUrl()),
        });
        const hash = await wallet.writeContract({
            chain: null,
            address: referralPayout,
            abi: REFERRAL_PAYOUT_ABI,
            functionName: 'notify',
            args: [referrer],
            value: wei,
        });
        await pub.waitForTransactionReceipt({hash});
    } finally {
        await stopImpersonating(hook);
    }
}

/** Publicly list a Punk for sale at `priceEth` ETH from `seller` (no
 *  `onlySellTo` restriction). Used by `acceptListing` spec to seed a
 *  PunkStrategy-style listing the Patron can sweep. Caller must own
 *  the Punk; this impersonates them. */
export async function publicListPunk(
    seller: Address,
    punkId: number,
    priceEth: string,
): Promise<void> {
    const {pub} = makeClients();
    const wei = parseEther(priceEth);
    await impersonate(seller);
    try {
        const wallet = createWalletClient({
            account: seller,
            transport: http(anvilRpcUrl()),
        });
        const hash = await wallet.writeContract({
            chain: null,
            address: PUNKS_MARKET,
            abi: MARKET_ABI,
            functionName: 'offerPunkForSale',
            args: [BigInt(punkId), wei],
        });
        await pub.waitForTransactionReceipt({hash});
    } finally {
        await stopImpersonating(seller);
    }
}

/** Read the current ETH balance of an address via eth_getBalance. */
export async function getBalance(addr: Address): Promise<bigint> {
    const {pub} = makeClients();
    const hex = (await pub.request({
        method: 'eth_getBalance' as never,
        params: [addr, 'latest'],
    } as never)) as `0x${string}`;
    return BigInt(hex);
}

/** Drive a `Patron.acceptBid` from `seller` by impersonating that address.
 *  Used to race in a competing acquisition that consumes a target trait
 *  between a test EOA's pick and its submit. `punkId` must already be
 *  pre-listed to Patron by `seller` (use `preListToPatron` first). */
export async function callAcceptBidAs(
    patron: Address,
    seller: Address,
    punkId: number,
    targetTraitId: number,
): Promise<void> {
    const {pub} = makeClients();
    // `expectedListingWei` is an overpay CAP — the protocol buys the listing for
    // at most this. The Punk was pre-listed at the live bid (`preListToPatron`
    // lists at `bidBalance()`), so cap at the current live bid.
    const expectedListingWei = (await pub.readContract({
        address: patron,
        abi: PATRON_ABI,
        functionName: 'bidBalance',
    })) as bigint;
    await impersonate(seller);
    try {
        const wallet = createWalletClient({
            account: seller,
            transport: http(anvilRpcUrl()),
        });
        const hash = await wallet.writeContract({
            chain: null,
            address: patron,
            abi: PATRON_ABI,
            functionName: 'acceptBid',
            args: [punkId, targetTraitId, expectedListingWei],
        });
        await pub.waitForTransactionReceipt({hash});
    } finally {
        await stopImpersonating(seller);
    }
}

export const SEED_MARKET_ABI = MARKET_ABI;
export const SEED_PATRON_ABI = PATRON_ABI;
