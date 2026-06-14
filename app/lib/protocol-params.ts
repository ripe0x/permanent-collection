/* Single source of truth for the protocol parameters surfaced in site
   copy. Change a number here once and every page that imports it updates
   in lockstep — there are no other hardcoded percentages in the copy.

   Every value mirrors a deployed-contract constant. The authoritative
   source for each is cited inline (contract + constant name) so this file
   can be diffed against the chain before launch. This file is COPY ONLY:
   live runtime values that depend on chain state (the live-bid balance,
   the collected count, auction countdowns) still come through the data
   adapter — only the deploy-time constants live here. */

/** Per-swap fee configuration on the official 111/ETH V4 pool.
 *  Source: `contracts/script/Deploy.s.sol` + the hook's `SkimHookFeeData`
 *  set at `initializePool`. */
export const FEES = {
    /** V4 LP fee, paid to liquidity providers via V4's standard mechanism
     *  (not the hook). Source: `Deploy.s.sol` `LP_FEE_PPM = 5000` (5000
     *  ppm = 0.5%). At launch the conversion locker holds 100% of LP
     *  positions and routes its share to LiveBidAdapter, so the LP fee
     *  effectively feeds the live bid until public LPs add depth. */
    lpFeePct: 0.5,

    /** Baseline skim the hook takes on every swap, split three ways inside
     *  `_processSkimAndAttribution`. Source: `Deploy.s.sol`
     *  `BASELINE_SKIM_BPS = 6000` (6%). */
    baselineSkimPct: 6,

    /** Total fee on a swap = LP fee + baseline skim. */
    totalSwapFeePct: 6.5,

    /** Baseline-skim breakdown — sums to baselineSkimPct. Source:
     *  `Deploy.s.sol` `BOUNTY_BPS = 8333` (~83.33% of the baseline → bid; the
     *  remaining ~16.67% → protocol). */
    bidLegPct: 5.0, // ~83.33% of 6% → LiveBidAdapter → Patron
    protocolLegPct: 1.0, // ~16.67% of 6% → ProtocolFeePhaseAdapter → PCController

    /** Maximum referral take, pulled from the protocol leg only — never
     *  reduces the bid leg. Paid from the first swap whenever the swap
     *  carries attribution; with no referrer the slice stays in the
     *  protocol leg. Source: `Deploy.s.sol`
     *  `MAX_REFERRAL_BPS_OF_VOLUME = 250` (250 / 100k = 0.25% of volume).
     *  Admin-tunable up to 1% via `TokenAdminPoker.setHookMaxReferralBps`;
     *  the launch/default value is 0.25%. */
    referralCapPct: 0.25,

    /** Same cap expressed as bps of volume in the hook's 100k-denom — the
     *  raw integer the swap-attribution encoder clamps against. Keep in
     *  sync with `referralCapPct` (250 / 100k = 0.25%). */
    referralCapBpsOfVolume: 250,

    /** PCController split applied to the protocol leg (from block 1).
     *  Source: the PC-dedicated `ProtocolFeeController`. The protocol leg is
     *  ~1% of volume; after the ≤0.25% referral carve the ~0.75% remainder
     *  splits ~86.67% PC treasury / ~13.33% LAYER buy-and-burn, i.e. team
     *  ≈0.65% and LAYER ≈0.1% of swap volume. */
    pcTreasuryPct: 86.67,
    layerBurnPct: 13.33,
} as const;

/** LiveBidAdapter metering — the two-mode drain of buffered inflow into the
 *  live bid. Below the activation threshold the buffer forwards uncapped (a
 *  fast launch warm-up); at or above it a rate cap throttles growth so a burst
 *  drips in instead of spiking the standing offer. Source:
 *  `contracts/script/Deploy.s.sol` (deploy seeds) and
 *  `contracts/src/LiveBidAdapter.sol` (band + bounds constants). */
export const ADAPTER = {
    /** Launch seed for the fast/throttled boundary, in ETH. Governs only the
     *  pre-first-acquisition window; after the first acceptBid the threshold
     *  auto-tracks (see `bandPct`). Source: `Deploy.s.sol`
     *  `ADAPTER_ACTIVATION_THRESHOLD = 30 ether`. */
    activationThresholdSeedEth: 30,
    /** On each acceptBid the threshold resets to this percent of the clearing
     *  price (the −25% band → 75% kept). Source:
     *  `LiveBidAdapter._syncActivationThreshold` (`priceWei * 75 / 100`). */
    bandPct: 75,
    /** Hard cap on the threshold, in ETH. Source: `LiveBidAdapter`
     *  `ACTIVATION_THRESHOLD_HI = 100 ether`. */
    thresholdCapEth: 100,
    /** Throttled-mode per-forward cap, in ETH. Source: `Deploy.s.sol`
     *  `ADAPTER_MAX_SWEEP_WEI = 2 ether`. */
    maxSweepEth: 2,
} as const;

/** Cleared (rescued) return-auction proceeds split, applied to the
 *  acquisition cost. Source: `ReturnAuctionModule.sol` — hard-coded, no
 *  setter. The three cost shares sum to 100%. */
export const CLEARED_SPLIT = {
    /** `CLEARED_BID_BPS = 6500` → refills the live bid via LiveBidAdapter. */
    liveBidPct: 65,
    /** Residual `cost − liveBid − vaultBurn` → BuybackBurner ($111 burn). */
    buybackBurnPct: 25,
    /** `CLEARED_VAULT_BURN_BPS = 1000` → VaultBurnPool, on top of premium. */
    vaultBurnPct: 10,
    /** Of the overbid premium `(highBid − cost)`, this share goes to the
     *  winning bid's referrer; the remainder joins the VaultBurnPool.
     *  Source: `REFERRER_PREMIUM_BPS = 500` (5% of premium). */
    referrerPremiumPct: 5,
} as const;

/** Finder fee paid to whoever bridges an allowlisted listing into the
 *  protocol via `acceptListing`. Source: `Patron.sol` — protocol
 *  constants, no setter. The fee is a share of the LIVE-BID BALANCE
 *  (not of the listing price), capped by an absolute ceiling. */
export const FINDER = {
    /** `finderFeeCapBps = 50` → 0.5% of the live-bid balance. */
    feePctOfBid: 0.5,
    /** `finderFeeFixedCap = 0.01 ether` → absolute ceiling. */
    feeFixedCapEth: 0.01,
    /** `MIN_BID_FOR_LISTING = 0.5 ether` → acceptListing only fires once
     *  the live bid is at least this large. */
    minBidForListingEth: 0.5,
} as const;

/** Anti-sniper window applied during the first ~30 minutes after pool
 *  init. Source: `ArtCoinsMevLinearSkim`, configured by `mevModuleConfig`
 *  in `Deploy.s.sol` as `(90_000, 6000, 1800)` — peak 90% skim (the hook's
 *  MAX_SKIM_BPS cap), baseline 6%, 1800 s = 30 min. */
export const ANTI_SNIPER = {
    peakPct: 90,
    baselinePct: 6,
    decayPctPerMin: 2.8,
    /** Auto-computed: (peak − baseline) / decay = the "~30 min" in copy. */
    get durationMin(): number {
        return (this.peakPct - this.baselinePct) / this.decayPctPerMin;
    },
} as const;

/** Return-auction parameters. Source: `ReturnAuctionModule.sol`
 *  (`AUCTION_DURATION = 72 hours`, `SNIPE_TRIGGER_WINDOW = 15 minutes`,
 *  `SNIPE_EXTENSION = 1 hours`). */
export const AUCTION = {
    durationHours: 72,
    /** Bids inside the last N minutes extend the deadline. */
    snipeExtensionTriggerMin: 15,
    /** Each anti-snipe trigger adds N hour(s) to the deadline. Uncapped. */
    snipeExtensionGainHours: 1,
    /** Reserve = cost × (101 + previousAttempts) / 100, rounded up
     *  (ceilDiv). First attempt for a trait reserves at 1.01× cost; each
     *  prior attempt against the same trait adds 1%. */
    reserveBasePct: 101,
} as const;

/** Vault Title auction. Source: `PunkVaultTitleAuction.sol`
 *  (`KICKOFF_THRESHOLD = 22`, `AUCTION_DURATION = 24 hours`,
 *  `MIN_INCREASE_BPS = 500`). 100% of cleared proceeds go to the immutable
 *  `payoutRecipient`; the live bid receives nothing from the Title path. */
export const TITLE = {
    /** Traits that must be collected before the Title can be kicked off
     *  (22 of 111 ≈ 20%). */
    kickoffThreshold: 22,
    durationHours: 24,
    /** Each new bid must clear the high by this much (500 bps = 5%). */
    minIncreasePct: 5,
    /** Share of cleared proceeds to `payoutRecipient`. */
    payoutSharePct: 100,
} as const;

/** Venue-scoped buy-side transfer tax on $111. Source: `Deploy.s.sol`
 *  `TRANSFER_TAX_BPS = 1500` (15% launch) and `TRANSFER_TAX_BPS_MAX =
 *  2000` (20% cap; the token's own `TAX_BPS_ABSOLUTE_MAX = 2000` is the
 *  structural backstop). Fires only on buys from a non-official trading
 *  venue toward a non-exempt recipient. Sells, wallet sends, lending,
 *  bridges, and CEX moves don't trigger it. Buys from the official pool
 *  are exempted via the hook's per-tx attested budget. Taxed tokens go
 *  to the dead address (never converted to ETH, never listed). Tunable
 *  within `[0, taxBpsMax]` via `TokenAdminPoker.setTokenTaxBps`. */
export const TAX = {
    launchPct: 15,
    capPct: 20,
} as const;

/** The unique forced edge in the trait → Punk bipartite matching. The
 *  sealed PunksData dataset has exactly one rarity-1 trait (bit 23, "7
 *  Attributes") carried by exactly one Punk (#8348). The records core
 *  enforces that #8348 can only accept the live bid against bit 23
 *  while bit 23 is uncollected, so the unique carrier of the unique
 *  rare trait can never be wasted on a common one. Source:
 *  `PermanentCollection.SOLE_CARRIER_TRAIT_BIT = 23` /
 *  `SOLE_CARRIER_PUNK_ID = 8348`. */
export const SOLE_CARRIER = {
    punkId: 8348,
    traitName: '7 Attributes',
} as const;

/** The $111 token itself. Source: `contracts/script/Deploy.s.sol`
 *  (`TOKEN_NAME`, `TOKEN_TOTAL_SUPPLY = 1_110_000_000e18`). The full supply
 *  is minted once at deploy by the artcoins factory and seeded entirely
 *  into the official pool's LP positions (held by the conversion locker) —
 *  there is no team / presale / treasury allocation and no post-launch
 *  mint. The user-facing ticker/symbol is NOT hardcoded here: read it from
 *  `getTokenTicker()` ("$111") / `getTokenSymbol()` ("111") so copy tracks
 *  the configured value. */
export const TOKEN = {
    name: 'permanent collection',
    /** Whole-token total supply (no decimals). Fixed forever. */
    totalSupplyWhole: 1_110_000_000,
    /** Pre-formatted for copy: "1,110,000,000". */
    totalSupplyDisplay: '1,110,000,000',
    /** Compact form for badges: "1.11B". */
    totalSupplyCompact: '1.11B',
} as const;

/** Protocol-wide collection constants. Source: the sealed PunksData
 *  dataset + `PunkVault` token-id layout. */
export const COLLECTION = {
    totalTraits: 111,
    /** Token id 111 on PunkVault is the Vault Title. */
    titleTokenId: 111,
    /** Token ids 0..110 on PunkVault are the Proof NFTs. */
    proofTokenCount: 111,
} as const;

/** Admin lifecycle. Source: `ProtocolAdmin.sol`
 *  (`ADMIN_TIMER_DURATION = 365 days`) + `Patron` allowlist carve-out
 *  (`ALLOWLIST_DELAY = 24 hours`). The timer is renewable via
 *  `transferAdmin` and only becomes permanent on role-burn
 *  (`transferAdmin(0)`) or by being allowed to lapse. */
export const ADMIN = {
    lockYears: 1,
    /** New seller-allowlist entries take effect after this delay. */
    allowlistDelayHours: 24,
} as const;

/** Format a percentage consistently across copy:
 *    5    -> "5%"
 *    3.75 -> "3.75%"
 *    1.0  -> "1%"   (trailing zero stripped — reads as "one percent")
 *    0.25 -> "0.25%"
 */
export function fmtPct(value: number): string {
    if (Number.isInteger(value)) return `${value}%`;
    return `${value.toString().replace(/\.0+$/, '')}%`;
}
