// Dev-only mock adapter. Exists so the UI can build + every state can be
// exercised (consent gate, tx states, all auction states, RPC error,
// market-down, empty) without touching live contracts.
//
// CRITICAL: production builds must fail loudly if this file is loaded.
// Use the `?mock` URL flag or `NEXT_PUBLIC_DATA_ADAPTER=mock` in dev only.

import {createPublicClient, http, fallback} from 'viem';
import {mainnet} from 'viem/chains';

import {abi as PatronAbi} from '@/lib/abis/Patron';
import {getContractAddresses, getRpcUrls} from '@/lib/config';
import {canonicalPunkId} from '../canonical-punks';
import {clearedSplitProvenanceEvents} from './clearedSplit';
import {countEligiblePunks, maskFromTraitIds} from './eligibleCount';
import {buildMosaicSvg} from '@/lib/mosaic-svg';
import {canonicalTarget, rarestFirst} from '@/lib/rarity';
import {PUNK_MASKS} from '@/lib/punkMasks';
import {buildTraitOptions, type TraitOptionEntry} from '@/lib/trait-options';
import type {
    AcceptedBidEvent,
    ActiveAuction,
    AuctionDetail,
    DataAdapter,
    PunkStrategyListing,
    MarketReference,
    ProtocolState,
    PunkEligibility,
    PunkProvenance,
    PunkProvenanceEvent,
    ResolvedAuction,
    TraitOption,
    TraitView,
    Address,
} from './types';

const NOW = BigInt(Math.floor(Date.now() / 1000));
const ETH = (n: number) => BigInt(Math.floor(n * 1e6)) * 10n ** 12n;

// Fixtures: 3 permanent traits (vaulted), 2 pending (in active auctions), the
// rest uncollected. Covers all three trait states in §3.
const PERMANENT_TRAITS = [2, 17, 56];
const PENDING_TRAITS = [69, 88];

// Mock mirror of the on-chain sole-carrier guard (PR #145, hard invariant
// #22). The live/fork adapters read PermanentCollection.soleCarrierConstraint;
// the mock hard-codes the pinned pair (#8348 ↔ bit 23 "7 Attributes") so the
// dev preview can exercise the warning + forced-default without a deployed
// contract. The pair stays uncollected in fixtures (23 ∉ PERMANENT_TRAITS), so
// the guard is always "required" for #8348 here.
const MOCK_SOLE_CARRIER_PUNK = 8348;
const MOCK_SOLE_CARRIER_BIT = 23;

/** Plausible mock trait names mirroring the real PunksData layout. Used in
 *  dev when NEXT_PUBLIC_DATA_ADAPTER=mock. The live adapter reads the actual
 *  names from PunksData. */
const MOCK_TRAIT_NAMES: string[] = (() => {
    const names: string[] = [];
    // bits 0..4: NormalizedType
    names.push('Alien', 'Ape', 'Female', 'Male', 'Zombie');
    // bits 5..15: HeadVariant
    names.push('Alien', 'Ape', 'Female 1', 'Female 2', 'Female 3', 'Female 4', 'Male 1', 'Male 2', 'Male 3', 'Male 4', 'Zombie');
    // bits 16..23: AttributeCount
    for (let i = 0; i <= 7; i++) names.push(`${i} Attributes`);
    // bits 24..110: Accessories (87 entries; lifted in spirit from the real set)
    const accessories = [
        '3D Glasses', 'Bandana', 'Beanie', 'Big Beard', 'Big Shades', 'Black Lipstick',
        'Blonde Bob', 'Blonde Short', 'Blue Eye Shadow', 'Buck Teeth', 'Cap', 'Cap Forward',
        'Cigarette', 'Classic Shades', 'Clown Eyes Blue', 'Clown Eyes Green', 'Clown Hair Green',
        'Clown Nose', 'Cowboy Hat', 'Crazy Hair', 'Dark Hair', 'Do-rag', 'Earring', 'Eye Mask',
        'Eye Patch', 'Fedora', 'Front Beard', 'Front Beard Dark', 'Frown', 'Frumpy Hair',
        'Goat', 'Gold Chain', 'Green Eye Shadow', 'Half Shaved', 'Handlebars', 'Headband',
        'Hoodie', 'Horned Rim Glasses', 'Hot Lipstick', 'Knitted Cap', 'Luxurious Beard',
        'Medical Mask', 'Messy Hair', 'Mohawk', 'Mohawk Dark', 'Mohawk Thin', 'Mole',
        'Muttonchops', 'Nerd Glasses', 'Normal Beard', 'Normal Beard Black', 'Orange Side',
        'Peak Spike', 'Pigtails', 'Pilot Helmet', 'Pink With Hat', 'Pipe', 'Police Cap',
        'Purple Eye Shadow', 'Purple Hair', 'Purple Lipstick', 'Red Mohawk', 'Regular Shades',
        'Rosy Cheeks', 'Shadow Beard', 'Shaved Head', 'Silver Chain', 'Small Shades',
        'Smile', 'Spots', 'Straight Hair', 'Straight Hair Blonde', 'Straight Hair Dark',
        'Stringy Hair', 'Tassle Hat', 'Tiara', 'Top Hat', 'VR', 'Vampire Hair', 'Vape',
        'Welding Goggles', 'Wild Blonde', 'Wild Hair', 'Wild White Hair',
    ];
    while (accessories.length < 87) accessories.push(`Accessory ${accessories.length}`);
    names.push(...accessories.slice(0, 87));
    return names;
})();

const ACTIVE_AUCTIONS: ActiveAuction[] = [
    {
        punkId: 1234,
        targetTraitId: 69,
        reserveWei: ETH(15.6),
        acquisitionCostWei: ETH(15),
        highBidWei: 0n,
        startedAt: NOW - 3600n,
        endsAt: NOW + 3600n * 71n,
        extensions: 0,
        attemptCount: 4,
    },
    {
        punkId: 5678,
        targetTraitId: 88,
        reserveWei: ETH(20.4),
        acquisitionCostWei: ETH(20),
        highBidWei: ETH(20.4),
        highBidder: '0xBEEF00000000000000000000000000000000BEEF',
        startedAt: NOW - 3600n * 70n,
        endsAt: NOW + 600n, // closing in 10 min — anti-snipe territory
        extensions: 2,
        attemptCount: 2,
    },
];

const RECENT_RESOLVED: ResolvedAuction[] = [
    {
        punkId: 2222,
        targetTraitId: 56,
        outcome: 'vaulted',
        finalBidWei: 0n,
        acquisitionPriceWei: ETH(14.2),
        settledAt: NOW - 86_400n * 3n,
        txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    {
        punkId: 333,
        targetTraitId: 12,
        outcome: 'cleared',
        finalBidWei: ETH(18.5),
        acquisitionPriceWei: ETH(17),
        // Cleared split of the 18.5 winning bid: 65% of cost → live bid, 25% →
        // buy-and-burn, remainder (3.2) → vault-burn pool.
        liveBidShareWei: ETH(11.05),
        burnShareWei: ETH(4.25),
        settledAt: NOW - 86_400n * 7n,
        txHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
];

const RECENT_ACCEPTED: AcceptedBidEvent[] = [
    {
        kind: 'bidAccepted',
        punkId: 5678,
        actor: '0xC0DE00000000000000000000000000000000C0DE',
        amountWei: ETH(20),
        blockNumber: 25_109_700n,
        timestamp: NOW - 3600n * 70n,
        txHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    },
    {
        kind: 'listingAccepted',
        punkId: 1234,
        actor: '0xB07700000000000000000000000000000000B077',
        amountWei: ETH(15),
        blockNumber: 25_109_400n,
        timestamp: NOW - 3600n,
        txHash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    },
];

/** Read the *real* on-chain bounty server-side, even in mock mode.
 *
 *  The live bid is the headline number and the spine of the "every swap
 *  grows the bid" affordance — it must reflect `Patron.bidBalance` so the
 *  SSR seed agrees with what `<LiveBidStat />` reads on the client. Without
 *  this, the homepage seeded a hardcoded 12.4 ETH while the client settled to
 *  the true value, and the two pages disagreed.
 *
 *  Falls back to `0n` (NOT the old 12.4 placeholder) if the fork RPC is
 *  unreachable or contract addresses aren't configured — a neutral seed never
 *  contradicts the client read. Reuses the same server-only `RPC_URL`
 *  transport as the live adapter; `chain: mainnet` is cosmetic for a uint256
 *  `eth_call` (the fork answers regardless of the declared chain id). */
async function readLiveBidSnapshot(): Promise<{
    liveBidWei: bigint;
    liveBidPendingWei: bigint;
}> {
    try {
        const addrs = getContractAddresses();
        const urls = getRpcUrls();
        const transports = urls.map((u) => http(u));
        const rpc = createPublicClient({
            chain: mainnet,
            transport: transports.length > 1 ? fallback(transports) : transports[0],
        });
        // The LiveBidAdapter is fed via receive() (no escrow claim), so its
        // pending is just its balance.
        const [liveBidWei, pendingBuf] = await Promise.all([
            rpc.readContract({
                address: addrs.patron,
                abi: PatronAbi,
                functionName: 'bidBalance',
            }) as Promise<bigint>,
            rpc.getBalance({address: addrs.liveBidAdapter}),
        ]);
        return {liveBidWei, liveBidPendingWei: pendingBuf};
    } catch {
        return {liveBidWei: 0n, liveBidPendingWei: 0n};
    }
}

export class MockAdapter implements DataAdapter {
    async getProtocolState(): Promise<ProtocolState> {
        // Live bid + pending read from chain (real); the rest stays mock
        // because there's no local indexer to source acquisition counts etc.
        const {liveBidWei, liveBidPendingWei} = await readLiveBidSnapshot();
        return {
            liveBidWei,
            liveBidPendingWei,
            // Mock is fixed post-acquisition (acquisitionCount: 7), so the
            // protocol leg routes to PCController, not Patron — 0 bid-bound.
            liveBidProtocolLegPendingWei: 0n,
            asOfBlock: 25_109_999n,
            asOfTimestamp: NOW,
            collectedCount: PERMANENT_TRAITS.length,
            totalTraits: 111,
            acquisitionCount: 7,
            vaultedCount: PERMANENT_TRAITS.length,
            clearedCount: 4,
            proofsMintedCount: PERMANENT_TRAITS.length,
            totalTokenSupplyWei: 833_140_048n * 10n ** 18n,
            totalTokenBurnedWei: 166_859_951n * 10n ** 18n,
            isComplete: false,
            totalSwapVolumeWei: 1_482n * 10n ** 18n,
            swapCount: 3_207,
        };
    }

    async getEligiblePunkCount(): Promise<number | null> {
        // Same computation as the live adapter, off the mock fixture state:
        // collected/pending masks from the trait lists, blocked Punks = the
        // vaulted exemplars + the in-auction Punks.
        const blocked = [
            ...PERMANENT_TRAITS.map((t) => canonicalPunkId(t)),
            ...ACTIVE_AUCTIONS.map((a) => a.punkId),
        ];
        return countEligiblePunks(
            maskFromTraitIds(PERMANENT_TRAITS),
            maskFromTraitIds(PENDING_TRAITS),
            blocked,
        );
    }

    async getTraitGrid(): Promise<TraitView[]> {
        const out: TraitView[] = [];
        for (let i = 0; i < 111; i++) {
            if (PERMANENT_TRAITS.includes(i)) {
                out.push({
                    traitId: i,
                    state: 'permanent',
                    // Vaulted Punk must actually carry the target trait — the
                    // contract enforces it on chain. Use the canonical exemplar
                    // since it's guaranteed to carry the trait (and matches
                    // what the on-chain renderer would draw for the cell).
                    firstVaultedPunkId: canonicalPunkId(i),
                    acceptedBidWei: ETH(10 + i / 10),
                    acquisitionTx: ('0x' + 'e'.repeat(64)) as `0x${string}`,
                });
            } else if (PENDING_TRAITS.includes(i)) {
                out.push({traitId: i, state: 'pending'});
            } else {
                out.push({traitId: i, state: 'uncollected'});
            }
        }
        return out;
    }

    async getActiveAuctions(): Promise<ActiveAuction[]> {
        return ACTIVE_AUCTIONS;
    }

    async getRecentResolutions(limit = 10): Promise<ResolvedAuction[]> {
        return RECENT_RESOLVED.slice(0, limit);
    }

    async getRecentAcceptedBids(limit = 10): Promise<AcceptedBidEvent[]> {
        return RECENT_ACCEPTED.slice(0, limit);
    }

    async getMarketReference(): Promise<MarketReference> {
        return {
            cheapestEligiblePriceWei: ETH(14.2),
            floorPriceWei: ETH(9.8),
            available: true,
            asOfTimestamp: NOW - 30n,
        };
    }

    async getAuctionByPunkId(punkId: number): Promise<AuctionDetail | null> {
        const a = ACTIVE_AUCTIONS.find((x) => x.punkId === punkId);
        return a ? {...a} : null;
    }

    async getResolvedAuctionByPunkId(punkId: number): Promise<ResolvedAuction | null> {
        return RECENT_RESOLVED.find((r) => r.punkId === punkId) ?? null;
    }

    async getTraitNames(): Promise<string[]> {
        return MOCK_TRAIT_NAMES;
    }

    async getPunkSprite(punkId: number): Promise<{indexed: Uint8Array; palette: Uint8Array}> {
        // Deterministic mock sprite: 24×24 indexed-color silhouette of a
        // generic punk head + a per-punk hash-driven accent. Enough to
        // exercise the renderer in dev.
        const indexed = new Uint8Array(576);
        // Palette: 0 = transparent, 1 = skin, 2 = dark eye, 3 = accent.
        const palette = new Uint8Array([
            0, 0, 0, 0,        // 0 transparent
            220, 165, 130, 255, // 1 skin
            27, 25, 22, 255,    // 2 dark
            (punkId * 53) & 0xff, (punkId * 17) & 0xff, (punkId * 91) & 0xff, 255, // 3 punk-specific accent
        ]);
        for (let row = 0; row < 24; row++) {
            for (let col = 0; col < 24; col++) {
                const i = row * 24 + col;
                // Round head from row 3 to 22, columns 6 to 18.
                const dx = col - 12;
                const dy = row - 13;
                const inHead = dx * dx + (dy * dy * 1.2) < 60;
                if (inHead) {
                    indexed[i] = 1; // skin
                    if ((row === 9 || row === 10) && (col === 9 || col === 14)) indexed[i] = 2; // eyes
                    if (row === 13 && col >= 11 && col <= 13) indexed[i] = 2; // mouth
                    // Accent stripe based on punkId for visual variety.
                    if (row >= 4 && row <= 5 && col >= 8 && col <= 16 && (punkId % 3 !== 0)) indexed[i] = 3;
                }
            }
        }
        return {indexed, palette};
    }

    async getRendererSvg(): Promise<string | null> {
        // Build the mosaic from the same trait state + artwork source
        // (buildMosaicSvg → lib/trait-tile.ts) the /collection grid uses, so
        // the dev/preview homepage matches /collection cell-for-cell — the
        // mock's PERMANENT_TRAITS/PENDING_TRAITS show through on both.
        return buildMosaicSvg(await this.getTraitGrid());
    }

    getTitleSvg(): Promise<string | null> {
        // In production the Title's tokenURI(111) wraps the same SVG bytes
        // the homepage shows via the zero-arg tokenURI(). Mirror that here
        // so dev preview of /title shows the same mosaic placeholder.
        return this.getRendererSvg();
    }

    async getPunkStrategyListings(): Promise<PunkStrategyListing[]> {
        // Two fixture rows so the dev preview exercises the row variants —
        // one with a single eligible trait, one with multiple. Both priced
        // below the mock liveBidWei (13.2 ETH).
        const ETH18 = 10n ** 18n;
        return [
            {
                punkId: 4521,
                seller: '0xAAAA000000000000000000000000000000000001' as Address,
                minValueWei: 12n * ETH18,
                suggestedTraitId: 45,
                eligibleTraitIds: [45],
                finderFeeWei: ETH18 / 100n, // 0.01 ETH
                bountyCostWei: 12n * ETH18 + ETH18 / 100n,
                listedAt: NOW - 1800n,
                soleCarrier: {required: false, requiredTraitId: 0},
            },
            {
                punkId: 7780,
                seller: '0xAAAA000000000000000000000000000000000001' as Address,
                minValueWei: 13n * ETH18,
                suggestedTraitId: 31,
                eligibleTraitIds: [31, 52, 74],
                finderFeeWei: ETH18 / 100n,
                bountyCostWei: 13n * ETH18 + ETH18 / 100n,
                listedAt: NOW - 600n,
                soleCarrier: {required: false, requiredTraitId: 0},
            },
            {
                // Sole-carrier fixture: #8348 is the unique carrier of bit 23
                // ("7 Attributes"). suggestedTraitId pre-selects the required
                // trait; deviating to the other eligible bit triggers the
                // listing-path warning + disabled accept.
                punkId: MOCK_SOLE_CARRIER_PUNK,
                seller: '0xAAAA000000000000000000000000000000000001' as Address,
                minValueWei: 11n * ETH18,
                suggestedTraitId: MOCK_SOLE_CARRIER_BIT,
                eligibleTraitIds: [MOCK_SOLE_CARRIER_BIT, 48],
                finderFeeWei: ETH18 / 100n,
                bountyCostWei: 11n * ETH18 + ETH18 / 100n,
                listedAt: NOW - 300n,
                soleCarrier: {required: true, requiredTraitId: MOCK_SOLE_CARRIER_BIT},
            },
        ];
    }

    async getPunksOwnedBy(): Promise<number[]> {
        // Mock: pretend the connected wallet owns a small fixed set across
        // varied trait combinations so the accept-flow grid can be exercised.
        // #8348 (even → owned by the mock caller) is the sole-carrier fixture.
        return [8348, 0, 1, 1190, 4156, 5577, 6529];
    }

    async getProofs(): Promise<import('./types').ProofView[]> {
        // Mock fixture: the three PERMANENT_TRAITS render as minted Proofs
        // (consistent with proofsMintedCount and the /collection grid); the
        // rest are unminted placeholders. Lets the dev preview exercise both
        // the minted and unminted cells + detail pages without a deploy.
        const traitNames = await this.getTraitNames();
        const out: import('./types').ProofView[] = [];
        for (let traitId = 0; traitId < 111; traitId++) {
            out.push(this._mockProofView(traitId, traitNames[traitId] ?? `Trait ${traitId}`));
        }
        return out;
    }

    /** Shared Proof-view builder so getProofs / getProofForTrait /
     *  getProofDetail can't drift in the fixture. */
    private _mockProofView(traitId: number, traitName: string): import('./types').ProofView {
        const mintedIdx = PERMANENT_TRAITS.indexOf(traitId);
        if (mintedIdx === -1) {
            return {
                tokenId: traitId,
                traitId,
                traitName,
                minted: false,
                punkId: 0,
                sequence: 0,
                mintedAtBlock: 0n,
                currentOwner: null,
                // Mock cannot read PunksData for the real trait icon, so it
                // emits a neutral placeholder frame so the page layout looks
                // right during dev.
                svgMarkup: mockUnmintedProofSvg(traitName),
            };
        }
        return {
            tokenId: traitId,
            traitId,
            traitName,
            minted: true,
            punkId: canonicalPunkId(traitId),
            sequence: mintedIdx + 1,
            mintedAtBlock: 21_000_000n + BigInt(mintedIdx * 7),
            currentOwner: MOCK_PROOF_OWNER,
            svgMarkup: mockMintedProofSvg(traitName),
        };
    }

    async getProofForTrait(traitId: number): Promise<import('./types').ProofView | null> {
        if (!PERMANENT_TRAITS.includes(traitId)) return null;
        const traitNames = await this.getTraitNames();
        return this._mockProofView(traitId, traitNames[traitId] ?? `Trait ${traitId}`);
    }

    async getProofDetail(tokenId: number): Promise<import('./types').ProofDetail | null> {
        const proof = await this.getProofForTrait(tokenId);
        if (!proof) return null;
        // Fixture provenance: an acceptBid (acquirer == seller) so the
        // detail page exercises the "given up by" + price + block rows.
        return {
            ...proof,
            provenance: {
                originalSeller: MOCK_PROOF_SELLER,
                acquirer: MOCK_PROOF_SELLER,
                acquisitionPriceWei: ETH(10 + tokenId / 10),
                acquiredAtBlock: proof.mintedAtBlock - 5_000n,
                via: 'acceptBid',
            },
        };
    }

    async getTitleNft(): Promise<import('./types').TitleNftView> {
        // Mint state tracks the same knob the mock Title Auction uses, so
        // `NEXT_PUBLIC_MOCK_TITLE_AUCTION_PHASE=settled` exercises the
        // minted-Title card; any other phase shows the pre-mint state.
        const phase = process.env.NEXT_PUBLIC_MOCK_TITLE_AUCTION_PHASE ?? 'live';
        const minted = phase === 'settled';
        return {
            minted,
            owner: minted ? MOCK_TITLE_OWNER : null,
            svgMarkup: await this.getRendererSvg(),
        };
    }

    /** Mock Title Auction: defaults to "live" mid-round with a single bid,
     *  so the dev UI exercises every primary panel. Override via
     *  `NEXT_PUBLIC_MOCK_TITLE_AUCTION_PHASE` to drive other states. */
    async getTitleAuctionState(caller?: import('./types').Address): Promise<import('./types').TitleAuctionState> {
        const ZERO = '0x0000000000000000000000000000000000000000' as import('./types').Address;
        const phase = (process.env.NEXT_PUBLIC_MOCK_TITLE_AUCTION_PHASE ?? 'live') as
            | 'not-deployed'
            | 'pre-threshold'
            | 'kickoff-ready'
            | 'live'
            | 'settleable'
            | 'settled';
        const PATRON_MOCK = '0xCAFE0000000000000000000000000000000000CA' as import('./types').Address;
        const PAYOUT_MOCK = '0xBEEF0000000000000000000000000000000000BE' as import('./types').Address;
        const high = ETH(12.5);
        const minNextBid = (high * 105n) / 100n;
        const baseEndsAt = NOW + 3600n * 18n;
        const collectedCount =
            phase === 'pre-threshold' ? 7 : phase === 'kickoff-ready' ? 56 : 62;
        const livePending = {
            patron: 0n,
            payoutRecipient: 0n,
        };
        // 100% of cleared Title proceeds route to payoutRecipient; the live
        // bid (Patron) receives nothing from the Title path.
        const settledPending = {
            patron: 0n,
            payoutRecipient: high,
        };
        const empty = {
            collectedCount,
            patronAddr: PATRON_MOCK,
            payoutRecipientAddr: PAYOUT_MOCK,
            pendingRefundForCaller: caller ? 0n : undefined,
        } as const;
        if (phase === 'not-deployed') {
            return {
                phase: 'not-deployed',
                isKickoffReady: false,
                isLive: false,
                isSettleable: false,
                kickedOff: false,
                settled: false,
                endsAt: 0n,
                highBidWei: 0n,
                minNextBidWei: 0n,
                restartCount: 0,
                extensionsThisRound: 0,
                pendingProceedsByAddr: livePending,
                ...empty,
            };
        }
        if (phase === 'pre-threshold') {
            return {
                phase: 'pre-threshold',
                isKickoffReady: false,
                isLive: false,
                isSettleable: false,
                kickedOff: false,
                settled: false,
                endsAt: 0n,
                highBidWei: 0n,
                minNextBidWei: 0n,
                restartCount: 0,
                extensionsThisRound: 0,
                pendingProceedsByAddr: livePending,
                ...empty,
            };
        }
        if (phase === 'kickoff-ready') {
            return {
                phase: 'kickoff-ready',
                isKickoffReady: true,
                isLive: false,
                isSettleable: false,
                kickedOff: false,
                settled: false,
                endsAt: 0n,
                highBidWei: 0n,
                minNextBidWei: 0n,
                restartCount: 0,
                extensionsThisRound: 0,
                pendingProceedsByAddr: livePending,
                ...empty,
            };
        }
        if (phase === 'settleable') {
            return {
                phase: 'settleable',
                isKickoffReady: false,
                isLive: false,
                isSettleable: true,
                kickedOff: true,
                settled: false,
                endsAt: NOW - 60n,
                highBidWei: high,
                highBidder: '0xABCD0000000000000000000000000000000000AB' as import('./types').Address,
                minNextBidWei: minNextBid,
                restartCount: 0,
                extensionsThisRound: 1,
                pendingProceedsByAddr: livePending,
                ...empty,
            };
        }
        if (phase === 'settled') {
            return {
                phase: 'settled',
                isKickoffReady: false,
                isLive: false,
                isSettleable: false,
                kickedOff: true,
                settled: true,
                endsAt: NOW - 7200n,
                highBidWei: high,
                highBidder: '0xABCD0000000000000000000000000000000000AB' as import('./types').Address,
                minNextBidWei: minNextBid,
                restartCount: 0,
                extensionsThisRound: 1,
                pendingProceedsByAddr: settledPending,
                ...empty,
            };
        }
        // Default: live
        return {
            phase: 'live',
            isKickoffReady: false,
            isLive: true,
            isSettleable: false,
            kickedOff: true,
            settled: false,
            endsAt: baseEndsAt,
            highBidWei: high,
            highBidder: '0xABCD0000000000000000000000000000000000AB' as import('./types').Address,
            minNextBidWei: minNextBid,
            restartCount: 0,
            extensionsThisRound: 0,
            pendingProceedsByAddr: livePending,
            ...empty,
        };
    }

    async getTitleAuctionBids(): Promise<import('./types').TitleAuctionBidEntry[]> {
        const phase = process.env.NEXT_PUBLIC_MOCK_TITLE_AUCTION_PHASE ?? 'live';
        if (phase === 'pre-threshold' || phase === 'kickoff-ready' || phase === 'not-deployed') return [];
        const ZERO_HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
        return [
            {
                bidder: '0xABCD0000000000000000000000000000000000AB' as import('./types').Address,
                amount: ETH(12.5),
                endsAt: NOW + 3600n * 18n,
                extended: false,
                blockNumber: 12345n,
                timestamp: NOW - 1800n,
                txHash: ZERO_HASH,
            },
            {
                bidder: '0xDEAD0000000000000000000000000000000000DE' as import('./types').Address,
                amount: ETH(8.2),
                endsAt: NOW + 3600n * 23n,
                extended: false,
                blockNumber: 12340n,
                timestamp: NOW - 7200n,
                txHash: ZERO_HASH,
            },
        ];
    }

    async getReturnAuctionBids(punkId: number): Promise<import('./types').ReturnAuctionBidEntry[]> {
        // Mock returns a tiny canned list so /auction/[punkId] renders a
        // populated bid history in storybook-style dev runs. The history is
        // not tied to a specific Punk — punkId is accepted purely for shape
        // parity with the live adapter.
        void punkId;
        const ZERO_HASH = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;
        return [
            {
                bidder: '0xCAFE0000000000000000000000000000000000CA' as import('./types').Address,
                amount: ETH(2.4),
                blockNumber: 12_445n,
                timestamp: NOW - 600n,
                txHash: ZERO_HASH,
            },
            {
                bidder: '0xBEEF0000000000000000000000000000000000BE' as import('./types').Address,
                amount: ETH(2.1),
                blockNumber: 12_400n,
                timestamp: NOW - 4_200n,
                txHash: ZERO_HASH,
            },
        ];
    }

    async getReferralStatus(
        referrer: import('./types').Address,
    ): Promise<import('./types').ReferralStatus> {
        // Mock returns a small fictional credit so the dashboard renders
        // populated state in dev. `stuckOnHookWei` is 0, the steady-state,
        // since the fresh-only hook flushes each swap's accrual in-tx.
        return {
            referrer,
            balance: ETH(0.0125),
            totalCredited: ETH(0.05),
            totalClaimed: ETH(0.0375),
            stuckOnHookWei: 0n,
            lastUpdatedAt: NOW - 600n,
        };
    }

    async getPunkProvenance(punkId: number): Promise<PunkProvenance> {
        const events: PunkProvenanceEvent[] = [];
        let currentListing: PunkProvenance['currentListing'];

        for (const a of RECENT_ACCEPTED.filter((e) => e.punkId === punkId)) {
            events.push({
                kind: 'acquired',
                source: 'protocol',
                amountWei: a.amountWei,
                actor: a.actor,
                timestamp: a.timestamp,
                txHash: a.txHash,
            });
        }
        const auction = ACTIVE_AUCTIONS.find((x) => x.punkId === punkId);
        if (auction && auction.highBidWei > 0n && auction.highBidder) {
            events.push({
                kind: 'bid',
                source: 'protocol',
                amountWei: auction.highBidWei,
                actor: auction.highBidder,
                timestamp: auction.startedAt + 1800n,
                txHash: ('0x' + 'b'.repeat(64)) as `0x${string}`,
            });
        }
        for (const r of RECENT_RESOLVED.filter((e) => e.punkId === punkId)) {
            if (r.outcome === 'vaulted') {
                events.push({kind: 'vaulted', source: 'protocol', traitId: r.targetTraitId, timestamp: r.settledAt, txHash: r.txHash});
            } else {
                events.push({
                    kind: 'returned',
                    source: 'protocol',
                    amountWei: r.finalBidWei,
                    traitId: r.targetTraitId,
                    timestamp: r.settledAt,
                    txHash: r.txHash,
                });
                events.push(
                    ...clearedSplitProvenanceEvents({
                        finalBidWei: r.finalBidWei,
                        liveBidShareWei: r.liveBidShareWei,
                        burnShareWei: r.burnShareWei,
                        traitId: r.targetTraitId,
                        timestamp: r.settledAt,
                        txHash: r.txHash,
                    }),
                );
            }
        }
        const hadProtocolEvents = events.length > 0;

        // Synthetic recent 2017-market history so the dev preview exercises
        // the market-event rows (sale / transfer). The live adapter sources
        // these from cryptopunks.app.
        events.push({
            kind: 'sale',
            source: 'market',
            amountWei: ETH(8 + (punkId % 5)),
            actor: '0x5E11E20000000000000000000000000000005E11' as Address,
            counterparty: '0xB0BB1E00000000000000000000000000000B0BB1' as Address,
            timestamp: NOW - 86_400n * 30n,
            txHash: ('0x' + 'a'.repeat(64)) as `0x${string}`,
        });
        events.push({
            kind: 'transfer',
            source: 'market',
            actor: '0x0000000000000000000000000000000000000000' as Address,
            counterparty: '0x5E11E20000000000000000000000000000005E11' as Address,
            timestamp: NOW - 86_400n * 45n,
            txHash: ('0x' + 'c'.repeat(64)) as `0x${string}`,
        });

        // Punks with no protocol activity get a synthetic live public listing
        // so the dev preview exercises the current-listing fact + listed row.
        if (!hadProtocolEvents) {
            currentListing = {
                minValueWei: ETH(12 + (punkId % 7)),
                seller: '0xD15C0000000000000000000000000000000D15C0' as Address,
            };
            events.push({
                kind: 'listed',
                source: 'market',
                amountWei: currentListing.minValueWei,
                actor: currentListing.seller,
                timestamp: NOW - 7200n,
                txHash: ('0x' + 'f'.repeat(64)) as `0x${string}`,
            });
        }
        events.sort((a, b) => (a.timestamp === b.timestamp ? 0 : a.timestamp < b.timestamp ? 1 : -1));
        return {punkId, events, currentListing};
    }

    async getPunkEligibility(punkId: number, caller?: Address): Promise<PunkEligibility> {
        // Mock owner: even punk → caller (if provided) owns it, else 0xCAFE.
        const fakeOwner = (
            caller && punkId % 2 === 0 ? caller : '0xCAFE000000000000000000000000000000000CAFE'
        ) as Address;

        // The Punk's REAL trait mask, snapshotted in punkMasks.ts. Earlier this
        // was synthesized from the punkId, which produced impossible
        // combinations (one Punk "carrying" several mutually exclusive types),
        // so the owned-Punks row didn't line up with the traits shown. The real
        // mask makes the mock faithful to what live/fork read from chain. #8348
        // genuinely carries bit 23, so the sole-carrier demo holds for free.
        const mask = (PUNK_MASKS[punkId] ?? 0n) & ((1n << 111n) - 1n);

        const collected = new Set(PERMANENT_TRAITS);
        const pending = new Set(PENDING_TRAITS);
        const soleCarrierRequired =
            punkId === MOCK_SOLE_CARRIER_PUNK && !collected.has(MOCK_SOLE_CARRIER_BIT);
        const uncollectedBits: number[] = [];
        const pendingBits: number[] = [];
        for (let i = 0; i < 111; i++) {
            if ((mask >> BigInt(i)) & 1n) {
                if (collected.has(i)) continue;
                uncollectedBits.push(i);
                if (pending.has(i)) pendingBits.push(i);
            }
        }

        return {
            punkId,
            owner: fakeOwner,
            caller,
            isOwnedByCaller: caller !== undefined && fakeOwner.toLowerCase() === caller.toLowerCase(),
            mask,
            uncollectedBits: rarestFirst(uncollectedBits),
            pendingBits,
            // Protocol-derived acceptance target (canonicalTargetOf mirror):
            // rarest uncollected non-pending bit. The caller no longer chooses.
            // Matches the live/fork field so dev/mock mode behaves identically.
            canonicalTargetId: canonicalTarget(uncollectedBits, pendingBits),
            // Mock: never pre-listed. The accept-bid UI will guide users
            // through the list step.
            listedToPatron: false,
            alreadyRecorded: false,
            soleCarrier: {
                required: soleCarrierRequired,
                requiredTraitId: soleCarrierRequired ? MOCK_SOLE_CARRIER_BIT : 0,
            },
        };
    }

    async getOwnedTraitOptions(owner: Address): Promise<TraitOption[]> {
        const owned = await this.getPunksOwnedBy();
        const eligs = await Promise.all(owned.map((id) => this.getPunkEligibility(id, owner)));
        let collectedMask = 0n;
        for (const b of PERMANENT_TRAITS) collectedMask |= 1n << BigInt(b);
        const pendingBits = new Set<number>(PENDING_TRAITS);
        const entries: TraitOptionEntry[] = eligs.map((e) => ({
            punkId: e.punkId,
            mask: e.mask,
            soleCarrier: e.soleCarrier,
        }));
        return buildTraitOptions(entries, collectedMask, pendingBits);
    }

    async getPunksListedToPatron(punkIds: number[]): Promise<number[]> {
        // No 2017-market listing state in the mock; nothing is pre-listed.
        void punkIds;
        return [];
    }
}

/** Server-side trait-tile SVG for an unminted Proof in mock mode.
 *  Matches the on-chain `PermanentCollectionProofRenderer` output: a
 *  square 24×24 viewBox with a `#8F918B` background. The mock can't reach
 *  PunksData for the real trait icon, so this emits a faint dashed
 *  placeholder where the icon would render in production. Live mode pulls
 *  the real icon from `traitIconCache.buildFragment(traitId)`. */
function mockUnmintedProofSvg(_traitName: string): string {
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" ' +
        'viewBox="0 0 24 24" shape-rendering="crispEdges">' +
        '<rect width="24" height="24" fill="#8F918B"/>' +
        '<rect x="6" y="6" width="12" height="12" fill="none" ' +
        'stroke="#3a3a3a" stroke-width="0.5" stroke-dasharray="1 1"/>' +
        '</svg>'
    );
}

/** Minted-Proof placeholder: a filled accent tile so the dev preview can
 *  tell a minted cell from an unminted one. Production swaps in the real
 *  museum-plate render from the on-chain Proof renderer. */
function mockMintedProofSvg(_traitName: string): string {
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" ' +
        'viewBox="0 0 24 24" shape-rendering="crispEdges">' +
        '<rect width="24" height="24" fill="#8F918B"/>' +
        '<rect x="6" y="6" width="12" height="12" fill="#d6603a"/>' +
        '</svg>'
    );
}

// Stable fixture identities for minted Proofs + the Title, so the dev
// preview renders concrete owners/sellers on the detail pages.
const MOCK_PROOF_OWNER = '0x00000000000000000000000000000000000000F1' as import('./types').Address;
const MOCK_PROOF_SELLER = '0x000000000000000000000000000000000000c0DE' as import('./types').Address;
const MOCK_TITLE_OWNER = '0x0000000000000000000000000000000000007171' as import('./types').Address;
