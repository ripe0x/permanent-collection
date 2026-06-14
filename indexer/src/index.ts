import {ponder} from 'ponder:registry';
import {
    acquisition,
    acquisitionHistory,
    adapterSweep,
    allowlistEntry,
    bid,
    bidEvent,
    burnStep,
    burnerDeposit,
    parameterChange,
    proof,
    protocolCounter,
    punkVaultTransfer,
    referralClaim,
    referralCredit,
    referrer,
    refund,
    returnAuction,
    titleAuctionBid,
    titleAuctionProceeds,
    titleAuctionRefund,
    titleAuctionState,
    traitTransition,
    traitTrial,
    vaultBurnSweep,
    vaultedPunk,
} from 'ponder:schema';

const GLOBAL = 'global';

// ─────────────────────────── helpers ───────────────────────────

async function bumpCounter(
    db: any,
    block: bigint,
    patch: Partial<{
        collectedDelta: number;
        acquisitionDelta: number;
        vaultedDelta: number;
        clearedDelta: number;
        proofsDelta: number;
        burnedEthDelta: bigint;
        burnedTokensDelta: bigint;
        bountyInflowDelta: bigint;
        vaultBurnSweepDelta: bigint;
        contributionVolumeDelta: bigint;
        swapVolumeDelta: bigint;
        swapCountDelta: number;
    }>,
) {
    await db
        .insert(protocolCounter)
        .values({
            id: GLOBAL,
            collectedCount: patch.collectedDelta ?? 0,
            acquisitionCount: patch.acquisitionDelta ?? 0,
            vaultedCount: patch.vaultedDelta ?? 0,
            clearedCount: patch.clearedDelta ?? 0,
            proofsMinted: patch.proofsDelta ?? 0,
            totalEthBurned: patch.burnedEthDelta ?? 0n,
            totalTokensBurned: patch.burnedTokensDelta ?? 0n,
            totalBountyInflowsWei: patch.bountyInflowDelta ?? 0n,
            totalVaultBurnSweptWei: patch.vaultBurnSweepDelta ?? 0n,
            totalContributionVolumeWei: patch.contributionVolumeDelta ?? 0n,
            totalSwapVolumeWei: patch.swapVolumeDelta ?? 0n,
            swapCount: patch.swapCountDelta ?? 0,
            lastUpdatedAt: block,
        })
        .onConflictDoUpdate((row: any) => ({
            collectedCount: row.collectedCount + (patch.collectedDelta ?? 0),
            acquisitionCount: row.acquisitionCount + (patch.acquisitionDelta ?? 0),
            vaultedCount: row.vaultedCount + (patch.vaultedDelta ?? 0),
            clearedCount: row.clearedCount + (patch.clearedDelta ?? 0),
            proofsMinted: row.proofsMinted + (patch.proofsDelta ?? 0),
            totalEthBurned: row.totalEthBurned + (patch.burnedEthDelta ?? 0n),
            totalTokensBurned: row.totalTokensBurned + (patch.burnedTokensDelta ?? 0n),
            totalBountyInflowsWei: row.totalBountyInflowsWei + (patch.bountyInflowDelta ?? 0n),
            totalVaultBurnSweptWei: row.totalVaultBurnSweptWei + (patch.vaultBurnSweepDelta ?? 0n),
            totalContributionVolumeWei:
                row.totalContributionVolumeWei + (patch.contributionVolumeDelta ?? 0n),
            totalSwapVolumeWei: row.totalSwapVolumeWei + (patch.swapVolumeDelta ?? 0n),
            swapCount: row.swapCount + (patch.swapCountDelta ?? 0),
            lastUpdatedAt: block,
        }));
}

// ─────────────────────────── Patron ───────────────────────────

ponder.on('Patron:BidAccepted', async ({event, context}) => {
    await context.db.insert(bidEvent).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        kind: 'Accepted',
        punkId: Number(event.args.punkId),
        seller: event.args.seller,
        amount: event.args.payout,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
});

ponder.on('Patron:ListingAccepted', async ({event, context}) => {
    await context.db.insert(bidEvent).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        kind: 'ListingAccepted',
        punkId: Number(event.args.punkId),
        seller: event.args.seller,
        caller: event.args.caller,
        amount: event.args.minValue,
        finderFee: event.args.finderFee,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
});

// Unattributed top-up via LiveBidAdapter.receive() — the adapter is the single
// faucet into the live bid. The full value enters the adapter buffer and meters
// into Patron via `sweep`. The amount is unchanged, so `bountyInflowDelta`
// still measures voluntary inflow destined for the bid.
ponder.on('LiveBidAdapter:BareTopUp', async ({event, context}) => {
    await context.db.insert(bidEvent).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        kind: 'BareTopUp',
        seller: event.args.sender,
        amount: event.args.amount,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
    await bumpCounter(context.db, event.block.number, {bountyInflowDelta: event.args.amount});
});

// Attribution-bearing top-up via LiveBidAdapter.contribute(referrer, tag). A
// ≤5% `referrerShare` is forwarded to the referrer; the remainder
// (`amount - referrerShare`) enters the adapter buffer and meters into the live
// bid via `sweep`.
ponder.on('LiveBidAdapter:Contribution', async ({event, context}) => {
    const bidInflow = event.args.amount - event.args.referrerShare;
    await context.db.insert(bidEvent).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        kind: 'Contribution',
        seller: event.args.contributor,
        amount: event.args.amount,
        referrer: event.args.referrer,
        tag: event.args.tag,
        referrerShare: event.args.referrerShare,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
    await bumpCounter(context.db, event.block.number, {
        bountyInflowDelta: bidInflow,
        contributionVolumeDelta: event.args.amount,
    });
});

// Cleared return-auction rescue refund (65% of cost) via
// LiveBidAdapter.poolReplenish — module-only. The refund enters the adapter
// buffer and meters into the live bid via `sweep`.
ponder.on('LiveBidAdapter:PoolReplenished', async ({event, context}) => {
    await context.db.insert(bidEvent).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        kind: 'PoolReplenished',
        punkId: Number(event.args.punkId),
        amount: event.args.amount,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
    await bumpCounter(context.db, event.block.number, {bountyInflowDelta: event.args.amount});
});

ponder.on('Patron:AllowedSellerAdded', async ({event, context}) => {
    await context.db
        .insert(allowlistEntry)
        .values({
            id: event.args.seller,
            seller: event.args.seller,
            active: true,
            addedAt: event.block.number,
        })
        .onConflictDoUpdate(() => ({
            active: true,
            addedAt: event.block.number,
            removedAt: null,
        }));
});

ponder.on('Patron:AllowedSellerRemoved', async ({event, context}) => {
    await context.db
        .update(allowlistEntry, {id: event.args.seller})
        .set({active: false, removedAt: event.block.number});
});

// Note: Patron no longer emits `ParameterChanged` — its only tunable economic
// parameters became protocol constants. The shared `parameterChange` table is
// still populated by the LiveBidAdapter and BuybackBurner handlers below.

// ─────────────────────────── LiveBidAdapter ───────────────────────────

ponder.on('LiveBidAdapter:Swept', async ({event, context}) => {
    await context.db.insert(adapterSweep).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        adapter: 'LiveBidAdapter',
        ethSwept: event.args.ethSwept,
        ethForwarded: event.args.ethForwarded,
        ethBuffered: event.args.ethBuffered,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
});

ponder.on('LiveBidAdapter:KeeperReward', async ({event, context}) => {
    // Patch the most-recent LiveBidAdapter flush in the same tx with keeper
    // info. We can't look up by partial id, so we write a paired record the UI
    // can join client-side: a separate row per keeper reward.
    await context.db.insert(adapterSweep).values({
        id: `${event.transaction.hash}-${event.log.logIndex}-reward`,
        adapter: 'LiveBidAdapter',
        ethSwept: 0n,
        ethForwarded: 0n,
        keeper: event.args.caller,
        keeperReward: event.args.amount,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
});

ponder.on('LiveBidAdapter:ParameterChanged', async ({event, context}) => {
    await context.db.insert(parameterChange).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        contract: 'LiveBidAdapter',
        key: event.args.key,
        oldValue: event.args.oldValue,
        newValue: event.args.newValue,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
});

// ─────────────────────────── Skim hook (official-pool volume) ───────────────────────────

// The hook emits one SkimSplit per swap with the swap's quote-currency (ETH)
// volume — the exact per-swap volume source, immune to the anti-sniper
// window's elevated skim (dividing bid inflows by the 5% leg share would
// overstate launch-window volume). The hook is shared infra that could host
// other pools via initializePoolOpen, so count ONLY the canonical pool:
// CANONICAL_POOL_ID gates when set; unset accepts all (local fork dev, where
// the fresh hook hosts exactly one pool).
ponder.on('SkimHook:SkimSplit', async ({event, context}) => {
    const canonicalPoolId = process.env.CANONICAL_POOL_ID?.toLowerCase();
    if (canonicalPoolId && event.args.poolId.toLowerCase() !== canonicalPoolId) return;
    await bumpCounter(context.db, event.block.number, {
        swapVolumeDelta: event.args.quoteVolume,
        swapCountDelta: 1,
    });
});

// ─────────────────────────── VaultBurnPool ───────────────────────────

ponder.on('VaultBurnPool:Swept', async ({event, context}) => {
    await context.db.insert(vaultBurnSweep).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        amount: event.args.amount,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
    await bumpCounter(context.db, event.block.number, {vaultBurnSweepDelta: event.args.amount});
});

// ─────────────────────────── PermanentCollection ───────────────────────────

ponder.on('PermanentCollection:AcquisitionRecorded', async ({event, context}) => {
    const punkId = Number(event.args.punkId);
    const targetTraitId = Number(event.args.targetTraitId);

    // A rescued (ReturnedToMarket) Punk can be re-acquired, so the per-Punk
    // `acquisition` row may already exist. Mirror the on-chain per-Punk readers
    // (latest-wins) with an upsert: overwrite the current row, increment the
    // per-Punk count. The full append-only log lives in `acquisitionHistory`.
    const prevAcq = await context.db.find(acquisition, {id: punkId});
    const seq = prevAcq ? prevAcq.acquisitionCount : 0; // 0-based per-Punk index
    const historyId = `${event.transaction.hash}-${event.log.logIndex}`;

    await context.db.insert(acquisitionHistory).values({
        id: historyId,
        punkId,
        seq,
        targetTraitId,
        mask: event.args.mask,
        pendingMaskAtAcquisition: event.args.pendingBits,
        acquirer: event.args.acquirer,
        originalSeller: event.args.originalSeller,
        priceWei: event.args.priceWei,
        acquiredAtBlock: event.args.acquiredAtBlock,
        custody: 'InReturnAuction',
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });

    await context.db
        .insert(acquisition)
        .values({
            id: punkId,
            punkId,
            targetTraitId,
            mask: event.args.mask,
            pendingMaskAtAcquisition: event.args.pendingBits,
            acquirer: event.args.acquirer,
            originalSeller: event.args.originalSeller,
            priceWei: event.args.priceWei,
            acquiredAtBlock: event.args.acquiredAtBlock,
            custody: 'InReturnAuction',
            acquisitionCount: 1,
            latestHistoryIndex: 0,
            latestHistoryId: historyId,
        })
        .onConflictDoUpdate((row: any) => ({
            targetTraitId,
            mask: event.args.mask,
            pendingMaskAtAcquisition: event.args.pendingBits,
            acquirer: event.args.acquirer,
            originalSeller: event.args.originalSeller,
            priceWei: event.args.priceWei,
            acquiredAtBlock: event.args.acquiredAtBlock,
            custody: 'InReturnAuction',
            custodyUpdatedAt: null,
            acquisitionCount: row.acquisitionCount + 1,
            latestHistoryIndex: row.acquisitionCount, // = new seq
            latestHistoryId: historyId,
        }));

    // Patron's flow runs `startSale` before `recordAcquisition` in the same tx,
    // so the returnAuction row was created before we knew the target. Patch it.
    const ra = await context.db.find(returnAuction, {id: punkId});
    if (ra && ra.targetTraitId === -1) {
        await context.db.update(returnAuction, {id: punkId}).set({targetTraitId});
    }

    // Bump the trial counter for the targeted trait.
    await context.db
        .insert(traitTrial)
        .values({
            id: targetTraitId,
            traitId: targetTraitId,
            count: 1,
            lastPunkId: punkId,
            lastUpdatedAt: event.block.number,
        })
        .onConflictDoUpdate((row: any) => ({
            count: row.count + 1,
            lastPunkId: punkId,
            lastUpdatedAt: event.block.number,
        }));

    await bumpCounter(context.db, event.block.number, {acquisitionDelta: 1});
});

ponder.on('PermanentCollection:TraitsPending', async ({event, context}) => {
    await context.db.insert(traitTransition).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        kind: 'Pending',
        punkId: Number(event.args.punkId),
        bits: event.args.pendingBits,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
});

ponder.on('PermanentCollection:TraitsCollected', async ({event, context}) => {
    await context.db.insert(traitTransition).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        kind: 'Collected',
        punkId: Number(event.args.punkId),
        bits: event.args.newlyCollectedBits,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
    // Every collected event is exactly one bit under the recorded-target rule;
    // popcount stays correct even for any pre-v2 multi-bit historical events.
    const bits = event.args.newlyCollectedBits as bigint;
    let popcount = 0;
    let x = bits;
    while (x !== 0n) {
        x &= x - 1n;
        popcount++;
    }
    await bumpCounter(context.db, event.block.number, {collectedDelta: popcount});
});

ponder.on('PermanentCollection:CustodyUpdated', async ({event, context}) => {
    const outcomeMap = ['None', 'InReturnAuction', 'ReturnedToMarket', 'Vaulted'];
    const outcome = outcomeMap[Number(event.args.outcome)] ?? 'Unknown';
    const punkId = Number(event.args.punkId);
    // Patch the latest per-Punk row. (The InReturnAuction transition is already
    // written by AcquisitionRecorded; this handler fires for the terminal
    // ReturnedToMarket / Vaulted transitions.)
    const acq = await context.db.find(acquisition, {id: punkId});
    await context.db
        .update(acquisition, {id: punkId})
        .set({custody: outcome, custodyUpdatedAt: event.block.number});
    // Patch the matching append-only history row so each acquisition record
    // carries its own terminal custody (a re-auctioned Punk's earlier rows keep
    // their own ReturnedToMarket outcome).
    if (acq?.latestHistoryId) {
        await context.db
            .update(acquisitionHistory, {id: acq.latestHistoryId})
            .set({custody: outcome, custodyUpdatedAt: event.block.number});
    }
    if (outcome === 'Vaulted') {
        await bumpCounter(context.db, event.block.number, {vaultedDelta: 1});
    } else if (outcome === 'ReturnedToMarket') {
        await bumpCounter(context.db, event.block.number, {clearedDelta: 1});
    }
});

// ─────────────────────────── ReturnAuctionModule ───────────────────────────

ponder.on('ReturnAuctionModule:ReturnAuctionStarted', async ({event, context}) => {
    // Look up the target trait recorded on the acquisition (filed in the same
    // tx). recordAcquisition runs after startSale within Patron, so for the
    // typical flow ReturnAuctionStarted fires before AcquisitionRecorded — read
    // defensively (target defaults to -1, patched later).
    const acq = await context.db.find(acquisition, {id: Number(event.args.punkId)});
    // A rescued Punk can be re-auctioned, so the per-Punk `returnAuction` row
    // may already exist from a prior auction. Upsert (latest-wins) and fully
    // reset the prior auction's settle state so the new auction starts clean —
    // mirrors the on-chain `startSale` slot reset.
    const startData = {
        punkId: Number(event.args.punkId),
        targetTraitId: acq?.targetTraitId ?? -1,
        acquisitionCost: event.args.acquisitionCost,
        reserveWei: event.args.reserveWei,
        startedAt: event.args.startedAt,
        endsAt: event.args.endsAt,
        highBidWei: 0n,
        highBidder: null,
        extensions: 0,
        settled: false,
        outcome: null,
        bountyShareWei: null,
        burnShareWei: null,
        settleKeeperReward: null,
    };
    await context.db
        .insert(returnAuction)
        .values({id: Number(event.args.punkId), ...startData})
        .onConflictDoUpdate(() => startData);
});

// Bids are tracked off the superset `BidPlaced` event; it carries
// punkId/bidder/amount/endsAt plus referrer/tag (the latter unused here).
ponder.on('ReturnAuctionModule:BidPlaced', async ({event, context}) => {
    const prev = await context.db.find(returnAuction, {id: Number(event.args.punkId)});
    const extended = prev !== null && event.args.endsAt > prev.endsAt;
    await context.db.insert(bid).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        punkId: Number(event.args.punkId),
        bidder: event.args.bidder,
        amount: event.args.amount,
        endsAt: event.args.endsAt,
        extended,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
    await context.db.update(returnAuction, {id: Number(event.args.punkId)}).set((row: any) => ({
        highBidWei: event.args.amount,
        highBidder: event.args.bidder,
        endsAt: event.args.endsAt,
        extensions: extended ? row.extensions + 1 : row.extensions,
    }));
});

ponder.on('ReturnAuctionModule:ReturnAuctionExtended', async ({event, context}) => {
    // Already accounted for in the Bid handler. Defensive overwrite of endsAt in
    // case event ordering ever shifts.
    await context.db
        .update(returnAuction, {id: Number(event.args.punkId)})
        .set({endsAt: event.args.newEndsAt});
});

ponder.on('ReturnAuctionModule:ReturnAuctionCleared', async ({event, context}) => {
    await context.db.update(returnAuction, {id: Number(event.args.punkId)}).set({
        settled: true,
        outcome: 'Cleared',
        bountyShareWei: event.args.liveBidShare,
        burnShareWei: event.args.burnShare,
    });
});

ponder.on('ReturnAuctionModule:PunkVaulted', async ({event, context}) => {
    const acq = await context.db.find(acquisition, {id: Number(event.args.punkId)});
    await context.db
        .update(returnAuction, {id: Number(event.args.punkId)})
        .set({settled: true, outcome: 'Vaulted'});
    await context.db.insert(vaultedPunk).values({
        id: Number(event.args.punkId),
        punkId: Number(event.args.punkId),
        collectedTraitId: acq?.targetTraitId ?? -1,
        vaultedAtBlock: event.block.number,
        txHash: event.transaction.hash,
    });
});

ponder.on('ReturnAuctionModule:RefundQueued', async ({event, context}) => {
    await context.db.insert(refund).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        kind: 'Queued',
        bidder: event.args.bidder,
        amount: event.args.amount,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
});

ponder.on('ReturnAuctionModule:RefundWithdrawn', async ({event, context}) => {
    await context.db.insert(refund).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        kind: 'Withdrawn',
        bidder: event.args.bidder,
        amount: event.args.amount,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
});

// ──────────────── PunkVault: Proof NFT mints + ERC721 transfers ────────────────

ponder.on('PunkVault:ProofMinted', async ({event, context}) => {
    const tokenId = Number(event.args.tokenId);
    await context.db.insert(proof).values({
        id: tokenId,
        tokenId,
        traitId: Number(event.args.traitId),
        punkId: Number(event.args.punkId),
        recipient: event.args.recipient,
        currentOwner: event.args.recipient,
        acquisitionId: event.args.acquisitionId,
        sequence: Number(event.args.sequence),
        mintedAtBlock: event.args.mintedAtBlock,
        mintedAt: event.block.timestamp,
        mintedTxHash: event.transaction.hash,
    });
    await bumpCounter(context.db, event.block.number, {proofsDelta: 1});
});

// Standard ERC721 Transfer covers: Title mint, Proof mints, and subsequent
// transfers. The Proof mint case is handled by `ProofMinted` above for richer
// metadata; this handler patches `currentOwner` on every transfer (mint
// included) and records the transfer log for activity feeds.
ponder.on('PunkVault:Transfer', async ({event, context}) => {
    const tokenId = Number(event.args.id);
    await context.db.insert(punkVaultTransfer).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        tokenId,
        from: event.args.from,
        to: event.args.to,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
    // Patch `currentOwner` on the Proof entity. Skipped for the Title
    // (tokenId 111 — no Proof row) and for transfers that race ahead of the
    // ProofMinted handler (the find guard handles both orderings).
    if (tokenId <= 110) {
        const existing = await context.db.find(proof, {id: tokenId});
        if (existing) {
            await context.db.update(proof, {id: tokenId}).set({
                currentOwner: event.args.to,
                lastTransferAtBlock: event.block.number,
                lastTransferAt: event.block.timestamp,
            });
        }
    }
});

// ─────────────────────────── PunkVaultTitleAuction ───────────────────────────
// One Title, one-shot english auction. The singleton titleAuctionState row
// (id = "global") tracks the running state; appended titleAuctionBid rows are
// the bid history; titleAuctionRefund / titleAuctionProceeds are the pull-queue
// activity streams.

async function getOrCreateTitleState(db: any, block: bigint) {
    const existing = await db.find(titleAuctionState, {id: GLOBAL});
    if (existing) return existing;
    await db.insert(titleAuctionState).values({
        id: GLOBAL,
        kickedOff: false,
        settled: false,
        endsAt: 0n,
        highBidWei: 0n,
        restartCount: 0,
        extensionsThisRound: 0,
        lastUpdatedAt: block,
    });
    return db.find(titleAuctionState, {id: GLOBAL});
}

ponder.on('PunkVaultTitleAuction:Kickoff', async ({event, context}) => {
    const prior = await context.db.find(titleAuctionState, {id: GLOBAL});
    if (!prior) {
        // Initial kickoff.
        await context.db.insert(titleAuctionState).values({
            id: GLOBAL,
            kickedOff: true,
            settled: false,
            endsAt: event.args.endsAt,
            highBidWei: 0n,
            restartCount: 0,
            extensionsThisRound: 0,
            lastUpdatedAt: event.block.timestamp,
        });
        return;
    }
    // No-bidder restart: bump round + reset extensions + clear the previous
    // high. Restart Kickoff fires only AFTER SettledNoBidder (which already
    // cleared them); mirror that here. `settled` stays false.
    await context.db.update(titleAuctionState, {id: GLOBAL}).set((row: any) => ({
        kickedOff: true,
        settled: false,
        endsAt: event.args.endsAt,
        highBidWei: 0n,
        highBidder: null,
        restartCount: row.restartCount + 1,
        extensionsThisRound: 0,
        lastUpdatedAt: event.block.timestamp,
    }));
});

ponder.on('PunkVaultTitleAuction:Bid', async ({event, context}) => {
    const prior = await getOrCreateTitleState(context.db, event.block.timestamp);
    const extended = event.args.endsAt > prior.endsAt;
    await context.db.insert(titleAuctionBid).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        bidder: event.args.bidder,
        amount: event.args.amount,
        endsAt: event.args.endsAt,
        extended,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
    await context.db.update(titleAuctionState, {id: GLOBAL}).set((row: any) => ({
        highBidWei: event.args.amount,
        highBidder: event.args.bidder,
        endsAt: event.args.endsAt,
        extensionsThisRound: extended ? row.extensionsThisRound + 1 : row.extensionsThisRound,
        lastUpdatedAt: event.block.timestamp,
    }));
});

ponder.on('PunkVaultTitleAuction:Extended', async ({event, context}) => {
    // The contract emits Extended IN ADDITION to Bid when an anti-snipe
    // extension fires. The Bid handler already accounted for endsAt + the
    // extensions counter; this is a defensive overwrite.
    await context.db
        .update(titleAuctionState, {id: GLOBAL})
        .set({endsAt: event.args.newEndsAt, lastUpdatedAt: event.block.timestamp});
});

ponder.on('PunkVaultTitleAuction:Settled', async ({event, context}) => {
    await context.db.update(titleAuctionState, {id: GLOBAL}).set({
        settled: true,
        clearedAt: event.block.timestamp,
        winner: event.args.winner,
        finalHighBidWei: event.args.highBid,
        lastUpdatedAt: event.block.timestamp,
    });
});

ponder.on('PunkVaultTitleAuction:SettledNoBidder', async ({event, context}) => {
    // The Kickoff handler bumps `restartCount` for the restart (which follows in
    // the same tx). Here we just clear the round's bid state.
    await context.db.update(titleAuctionState, {id: GLOBAL}).set({
        highBidWei: 0n,
        highBidder: null,
        lastUpdatedAt: event.block.timestamp,
    });
});

ponder.on('PunkVaultTitleAuction:RefundQueued', async ({event, context}) => {
    await context.db.insert(titleAuctionRefund).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        kind: 'Queued',
        bidder: event.args.bidder,
        amount: event.args.amount,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
});

ponder.on('PunkVaultTitleAuction:RefundWithdrawn', async ({event, context}) => {
    await context.db.insert(titleAuctionRefund).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        kind: 'Withdrawn',
        bidder: event.args.bidder,
        amount: event.args.amount,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
});

ponder.on('PunkVaultTitleAuction:ProceedsQueued', async ({event, context}) => {
    await context.db.insert(titleAuctionProceeds).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        kind: 'Queued',
        recipient: event.args.recipient,
        amount: event.args.amount,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
});

ponder.on('PunkVaultTitleAuction:ProceedsWithdrawn', async ({event, context}) => {
    await context.db.insert(titleAuctionProceeds).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        kind: 'Withdrawn',
        recipient: event.args.recipient,
        amount: event.args.amount,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
});

// ─────────────────────────── BuybackBurner ───────────────────────────

ponder.on('BuybackBurner:BurnEthDeposited', async ({event, context}) => {
    await context.db.insert(burnerDeposit).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        source: event.args.source,
        amount: event.args.amount,
        remainingEth: event.args.remainingEth,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
});

ponder.on('BuybackBurner:TokensBurned', async ({event, context}) => {
    await context.db.insert(burnStep).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        ethSpent: event.args.ethSpent,
        tokensBurned: event.args.tokensBurned,
        remainingEth: event.args.remainingEth,
        executionReward: 0n,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
    await bumpCounter(context.db, event.block.number, {
        burnedEthDelta: event.args.ethSpent,
        burnedTokensDelta: event.args.tokensBurned,
    });
});

ponder.on('BuybackBurner:ExecutionRewardPaid', async ({event, context}) => {
    // Paired with TokensBurned in the same tx (different logIndex). Store as a
    // sibling row keyed on logIndex so the frontend can join client-side.
    await context.db.insert(burnStep).values({
        id: `${event.transaction.hash}-${event.log.logIndex}-reward`,
        ethSpent: 0n,
        tokensBurned: 0n,
        remainingEth: 0n,
        executionReward: event.args.amount,
        caller: event.args.caller,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
});

ponder.on('BuybackBurner:ParameterChanged', async ({event, context}) => {
    await context.db.insert(parameterChange).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        contract: 'BuybackBurner',
        key: event.args.key,
        oldValue: event.args.oldValue,
        newValue: event.args.newValue,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
});

// ─────────────────────────── ReferralPayout ───────────────────────────
// Per-referrer balance ledger. The hook calls `notify(referrer)` within the
// same tx as an attributed swap → `ReferralCredited`, bumping the running
// balance. The referrer pulls via `claim()` (or anyone via `claimFor`) →
// `ReferralClaimed`, draining the balance.

ponder.on('ReferralPayout:ReferralCredited', async ({event, context}) => {
    await context.db.insert(referralCredit).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        referrer: event.args.referrer,
        amount: event.args.amount,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
    await context.db
        .insert(referrer)
        .values({
            id: event.args.referrer,
            referrer: event.args.referrer,
            balance: event.args.amount,
            totalCredited: event.args.amount,
            totalClaimed: 0n,
            lastCreditedAt: event.block.timestamp,
            lastUpdatedAt: event.block.timestamp,
        })
        .onConflictDoUpdate((row: any) => ({
            balance: row.balance + event.args.amount,
            totalCredited: row.totalCredited + event.args.amount,
            lastCreditedAt: event.block.timestamp,
            lastUpdatedAt: event.block.timestamp,
        }));
});

ponder.on('ReferralPayout:ReferralClaimed', async ({event, context}) => {
    await context.db.insert(referralClaim).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        referrer: event.args.referrer,
        amount: event.args.amount,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
    });
    // The contract reverts `NothingToClaim` on a zero balance, so a referrer row
    // already exists. Upsert defensively in case of out-of-order delivery.
    await context.db
        .insert(referrer)
        .values({
            id: event.args.referrer,
            referrer: event.args.referrer,
            balance: 0n,
            totalCredited: event.args.amount,
            totalClaimed: event.args.amount,
            lastClaimedAt: event.block.timestamp,
            lastUpdatedAt: event.block.timestamp,
        })
        .onConflictDoUpdate((row: any) => ({
            balance: row.balance - event.args.amount,
            totalClaimed: row.totalClaimed + event.args.amount,
            lastClaimedAt: event.block.timestamp,
            lastUpdatedAt: event.block.timestamp,
        }));
});
