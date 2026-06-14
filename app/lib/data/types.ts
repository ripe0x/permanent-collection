// Shared types for the data layer. Live (indexer + RPC) and mock adapters
// both implement `DataAdapter`. Components consume `DataAdapter` exclusively
// — they don't know whether they're hitting chain, indexer, or fixtures.

export type Address = `0x${string}`;
export type Hex = `0x${string}`;
export type BigIntString = string; // serialized bigint for transport

/** A single trait id 0..110, mapped to the renderer's 11x11 grid. */
export type TraitId = number;

/** Three render states the brief enumerates. */
export type TraitState = 'uncollected' | 'pending' | 'permanent';

export interface TraitView {
    traitId: TraitId;
    state: TraitState;
    /** For permanent traits: the Punk whose vault settle collected this bit. */
    firstVaultedPunkId?: number;
    /** For permanent traits: the bounty paid when the Punk was acquired. */
    acceptedBidWei?: bigint;
    /** For permanent traits: the acquisition tx hash. */
    acquisitionTx?: Hex;
}

/** Singleton protocol state surfaced on the homepage hero. */
export interface ProtocolState {
    /** Patron contract's current bounty balance in wei (the "live bid"). */
    liveBidWei: bigint;
    /** Fee ETH still upstream of Patron that will drip into the live bid on the
     *  next sweep. The LiveBidAdapter (the bid leg) is the only fee leg that
     *  funds the live bid, so this is its wei balance. The protocol leg sweeps
     *  to PCController and never reaches the bid, so it isn't counted. Surfaced
     *  as the smaller counter under the live-bid value. */
    liveBidPendingWei: bigint;
    /** Always 0 — retained in the shape for client back-compat. The protocol
     *  leg (ProtocolFeePhaseAdapter) sweeps to PCController from block 1 and is
     *  never bid-bound, so there is no protocol-leg pending to surface. The
     *  sweep affordance reads this and, seeing 0, fires only the bid-leg sweep. */
    liveBidProtocolLegPendingWei: bigint;
    /** Block at which `liveBidWei` was read. */
    asOfBlock: bigint;
    /** Block timestamp. */
    asOfTimestamp: bigint;
    collectedCount: number;
    totalTraits: 111;
    acquisitionCount: number;
    vaultedCount: number;
    clearedCount: number;
    /** Count of Proof NFTs minted from PunkVault (0..111). Equals the
     *  number of first-vaultings the protocol has seen — diverges from
     *  `vaultedCount` only if multiple Punks are vaulted for the same
     *  trait (only the first mints a Proof). */
    proofsMintedCount: number;
    totalTokenSupplyWei: bigint;
    totalTokenBurnedWei: bigint;
    isComplete: boolean;
    /** Lifetime official-pool swap volume in wei (the ETH side of every swap,
     *  buys and sells), exact from the hook's per-swap `SkimSplit` events via
     *  the indexer. `null` when the deployed indexer predates the field or is
     *  unreachable — callers hide the figure rather than estimate. */
    totalSwapVolumeWei: bigint | null;
    /** Lifetime official-pool swap count, same source + null semantics. */
    swapCount: number | null;
}

/** A single active return auction (return auction) on a Punk. */
export interface ActiveAuction {
    punkId: number;
    targetTraitId: TraitId;
    /** Reserve = acquisitionCost × (101 + previousTrials) / 100. */
    reserveWei: bigint;
    acquisitionCostWei: bigint;
    /** Current high bid; 0 if none. */
    highBidWei: bigint;
    highBidder?: Address;
    startedAt: bigint;
    endsAt: bigint;
    extensions: number;
    /** Per-target trial counter the reserve was derived from. */
    attemptCount: number;
}

/** Resolved auction outcome (Cleared = Punk returned to market via bid, Vaulted = permanent). */
export type AuctionOutcome = 'cleared' | 'vaulted';

export interface ResolvedAuction {
    punkId: number;
    targetTraitId: TraitId;
    outcome: AuctionOutcome;
    finalBidWei: bigint;
    /** Price the protocol paid to acquire the Punk (the live bid at the
     *  time of acceptance). Surfaced for vaulted rows so the row reads
     *  "vaulted at X ETH" instead of a dash. Undefined when the
     *  acquisition record is missing (legacy / fork edge cases). */
    acquisitionPriceWei?: bigint;
    /** Cleared-path distribution of the winning bid (`finalBidWei`),
     *  event-sourced. `liveBidShareWei` returned to the live bid (the bid pool),
     *  `burnShareWei` bought-and-burned; the remainder of `finalBidWei` goes to
     *  the vault-burn pool (plus any referral share of the premium). Undefined
     *  for vaulted auctions and legacy rows where the indexer lacks the split. */
    liveBidShareWei?: bigint;
    burnShareWei?: bigint;
    settledAt: bigint;
    txHash: Hex;
}

/** A public 2017-market listing the protocol can accept via
 *  `Patron.acceptListing`: seller is allowlisted (PunkStrategy at launch and
 *  any future aligned listing contracts) and past their 24h activation,
 *  price is at or below the live bid, and the Punk carries at least one
 *  uncollected + non-pending trait. Anyone can submit the accept tx; the
 *  caller earns the finder fee. */
export interface PunkStrategyListing {
    punkId: number;
    seller: Address;
    /** Listing price the protocol pays the seller via `buyPunk`. */
    minValueWei: bigint;
    /** The target trait the UI defaults to — the rarest eligible trait
     *  (lowest on-chain carrier count), or the sole-carrier-required trait
     *  when `soleCarrier.required`. The caller can override at submit time. */
    suggestedTraitId: TraitId;
    /** All uncollected + non-pending bits the caller can pick from, ordered
     *  rarest-first. */
    eligibleTraitIds: TraitId[];
    /** Finder fee the caller earns: identical to the contract's formula. */
    finderFeeWei: bigint;
    /** Total cost to the bounty = minValueWei + finderFeeWei. */
    bountyCostWei: bigint;
    /** Last time the listing changed (created or repriced). */
    listedAt: bigint;
    /** Sole-carrier guard for this Punk (hard invariant #22). When
     *  `required`, `acceptListing` reverts unless the target is
     *  `requiredTraitId`. */
    soleCarrier: SoleCarrierConstraint;
}

export interface AcceptedBidEvent {
    kind: 'bidAccepted' | 'listingAccepted';
    punkId: number;
    actor: Address; // the owner who accepted (bidAccepted) or the caller (listingAccepted)
    amountWei: bigint;
    blockNumber: bigint;
    timestamp: bigint;
    txHash: Hex;
}

/** Market-data view (external, best-effort). */
export interface MarketReference {
    /** Lowest publicly-listed CryptoPunk eligible to be acquired (i.e. carries
     *  at least one uncollected trait). Wei. */
    cheapestEligiblePriceWei?: bigint;
    /** The true CryptoPunks collection floor: the single cheapest publicly-listed
     *  Punk, regardless of whether it carries an uncollected trait. Wei. Surfaced
     *  alongside `cheapestEligiblePriceWei` so a seller reviewing the live bid can
     *  see both the open-market floor and the cheapest Punk the protocol could
     *  acquire. */
    floorPriceWei?: bigint;
    /** Whether the market reference is currently usable. False means the
     *  upstream is down or rate-limited; UI should degrade gracefully. */
    available: boolean;
    asOfTimestamp?: bigint;
}

// ──────────────── Per-Punk provenance ────────────────

/** A single event in a Punk's history. `source` distinguishes the public
 *  2017 market from this protocol's own lifecycle. */
export type PunkProvenanceKind =
    // Market (2017 CryptoPunks market, sourced from cryptopunks.app):
    | 'listed' // offered for public sale
    | 'sale' // sold for value
    | 'transfer' // transferred with no value
    | 'marketBid' // a bid placed on the 2017 market
    // Protocol (this protocol's own lifecycle, indexer-sourced):
    | 'acquired' // bounty/listing accepted → entered return auction
    | 'bid' // a return auction bid
    | 'returned' // return auction cleared → Punk returned to circulation
    | 'vaulted' // return auction lapsed → Punk vaulted permanently
    | 'bidRefill' // cleared-settle cost share that refills the live bid (→ Patron)
    | 'tokenBuyBurn' // cleared-settle cost share bought-and-burned (→ BuybackBurner)
    | 'tokenBurn'; // cleared-settle remainder routed to the vault-burn pool (burned later)

export interface PunkProvenanceEvent {
    kind: PunkProvenanceKind;
    source: 'market' | 'protocol';
    /** Price / bid / listing amount, where the event carries one. */
    amountWei?: bigint;
    /** Target trait (acquired) or collected trait (vaulted), where applicable. */
    traitId?: TraitId;
    /** Primary actor: seller, finder, bidder, or sender. */
    actor?: Address;
    /** The other party: buyer or recipient, for market sales/transfers. */
    counterparty?: Address;
    /** Unix seconds. 0 only when the source exposes no usable timestamp. */
    timestamp: bigint;
    txHash?: Hex;
}

/** A Punk's combined provenance: this protocol's lifecycle events
 *  (indexer-sourced) merged with the Punk's recent public 2017-market history
 *  (from cryptopunks.app, mainnet only — best-effort, deduped by tx hash so a
 *  protocol acquisition/vault isn't double-counted as a market sale/transfer).
 *  `currentListing` reflects the live public 2017-market offer when one
 *  exists. */
export interface PunkProvenance {
    punkId: number;
    /** Newest first. */
    events: PunkProvenanceEvent[];
    currentListing?: {minValueWei: bigint; seller: Address};
}

// ──────────────── Sole-carrier guard (hard invariant #22) ────────────────

/** Frontend mirror of `PermanentCollection.soleCarrierConstraint(punkId)` —
 *  the single on-chain source of truth (do NOT re-derive the pinned punk/bit
 *  off-chain). A Punk is constrained when it is the unique carrier of an
 *  uncollected trait: acquiring it toward anything else reverts
 *  `SoleCarrierMustTargetTrait` and would permanently strand that trait from
 *  the Full Set. This is a UX defence-in-depth layer — the contract is the
 *  actual guarantee — so reads of it fail OPEN (no false blocking). */
export interface SoleCarrierConstraint {
    /** True iff acquiring this Punk MUST target `requiredTraitId`. */
    required: boolean;
    /** The only valid target trait while `required` is true (`0` otherwise). */
    requiredTraitId: TraitId;
}

// ──────────────── Trait-first acquisition view ────────────────

/** The four trait dimensions of the dataset (mirrors `CategoryGroup` in the
 *  generated categories.ts). Fixed forever by the artwork. */
export type TraitGroup = 'normalizedType' | 'headVariant' | 'attributeCount' | 'accessory';

/** One selectable trait in the trait-first acquire UI: a trait the caller can
 *  make permanent, plus every Punk that can VALIDLY deliver it. The sole-
 *  carrier guard (hard invariant #22) is baked into the aggregation — a Punk
 *  that is the unique carrier of an uncollected trait appears ONLY under that
 *  required trait, never under its other traits — so `punkIds` is always a set
 *  of legal (trait, Punk) pairings and the UI cannot pre-select a revert. */
export interface TraitOption {
    traitId: TraitId;
    /** On-chain carrier count across the 10,000-Punk dataset (RARITY); lower is
     *  rarer. The trait list is ordered by this, rarest-first. */
    carrierCount: number;
    /** Trait taxonomy group, for section labels in the UI. */
    group: TraitGroup;
    /** Punk ids that can validly deliver this trait as its permanent target.
     *  For the owned-Punk (acceptBid) flow these are the caller's Punks; for
     *  the listings (acceptListing) flow they are publicly-listed Punks. Never
     *  empty. */
    punkIds: number[];
    /** True iff exactly one Punk in the whole dataset carries this trait
     *  (carrierCount === 1) — the unique forced edge (#8348 / "7 Attributes").
     *  Drives the "only carrier in existence" affirmation. */
    uniqueCarrier: boolean;
}

/** One publicly-listed Punk that can deliver a trait via `acceptListing`. */
export interface ListedTraitListing {
    punkId: number;
    seller: Address;
    /** Listing price the protocol pays the seller via `buyPunk`. */
    minValueWei: bigint;
    /** Finder fee the caller (anyone) earns for accepting. */
    finderFeeWei: bigint;
    /** Total cost to the bid = minValueWei + finderFeeWei. */
    bountyCostWei: bigint;
    listedAt: bigint;
}

/** The trait-first view of public listings (acceptListing): a trait the caller
 *  can make permanent right now, plus the listed Punks that can deliver it,
 *  cheapest-first. Same sole-carrier baking as `TraitOption` — a unique carrier
 *  appears only under its required trait. */
export interface ListedTraitOption {
    traitId: TraitId;
    carrierCount: number;
    group: TraitGroup;
    uniqueCarrier: boolean;
    listings: ListedTraitListing[];
}

// ──────────────── Punk eligibility view ────────────────

/** Result of resolving a Punk against the live protocol state. The accept-
 *  the-bid flow renders this directly: which traits are uncollected and
 *  therefore valid acceptance targets. */
export interface PunkEligibility {
    punkId: number;
    /** Bytecode-level owner from the 2017 market. */
    owner: Address;
    /** Caller's wallet, for context — undefined if not provided. */
    caller?: Address;
    /** True iff `owner === caller`. */
    isOwnedByCaller: boolean;
    /** PunksData bitmask of all traits the Punk carries (popcount 1..4). */
    mask: bigint;
    /** Subset of `mask` that's not yet in collectedMask, ordered rarest-first
     *  (ascending on-chain carrier count) so the picker can default to the
     *  rarest uncollected trait. */
    uncollectedBits: number[];
    /** Subset of uncollectedBits that's currently in pending state (i.e. has
     *  an in-flight return auction with this trait as the target). These are
     *  ineligible — only one acquisition per trait can be in-flight at a
     *  time. */
    pendingBits: number[];
    /** The single protocol-derived target trait the contract will collect if
     *  this Punk is accepted and silenced — the rarest uncollected, non-pending
     *  trait it carries (ties broken by lowest bit index). Frontend mirror of
     *  `PermanentCollection.canonicalTargetOf(punkId)`; `acceptBid` /
     *  `acceptListing` revert (`NotCanonicalTarget` / `TargetNotCanonical`)
     *  unless `targetTraitId` equals this. `undefined` when no eligible target
     *  remains (every trait already permanent or pending) — the Punk is not
     *  acceptable; on-chain `canonicalTargetOf` reverts `NoEligibleTarget`. The
     *  protocol chooses this, not the caller. */
    canonicalTargetId?: number;
    /** True if the Punk is already listed exclusively to Patron at a positive
     *  price at or below the live bid, the required precondition for
     *  acceptBid. */
    listedToPatron: boolean;
    /** True if the Punk has any record on the protocol (custody != None).
     *  An already-recorded Punk cannot be acquired again. */
    alreadyRecorded: boolean;
    /** Sole-carrier guard for this Punk (hard invariant #22). When
     *  `required`, the acceptBid target MUST be `requiredTraitId` or the tx
     *  reverts. */
    soleCarrier: SoleCarrierConstraint;
}

// ──────────────── Single-auction detail view ────────────────

export interface AuctionDetail extends ActiveAuction {
    /** Outgoing bidders' refund balances (pendingRefund[bidder]). */
    pendingRefundFor?: {bidder: Address; amount: bigint};
}

// ──────────────── Proofs ────────────────

/** One row per Proof slot (token id 1..111). Pre-mint Proofs report
 *  `minted: false` and zero-valued data; minted Proofs carry the
 *  full mint record. The current owner is queried separately when
 *  needed; this view is the contribution event, frozen at mint time. */
export interface ProofView {
    /** Token id on PunkVault. **Equal to `traitId` directly** (0..110) —
     *  Proof for trait 20 is token id 20. The Title sits at id 111. */
    tokenId: number;
    /** Trait id (0..110), identical to `tokenId`. Both are kept on the
     *  view for clarity — `tokenId` for marketplace/ownership context,
     *  `traitId` for protocol/render context. */
    traitId: number;
    /** Human-readable trait name (e.g. "Beanie"). */
    traitName: string;
    /** True iff this Proof has been minted. */
    minted: boolean;
    /** Punk that brought this trait into the collection (0 pre-mint). */
    punkId: number;
    /** 1-based collection sequence; equals `collectedCount()` at mint
     *  time. May diverge from `traitId` (traits are vaulted in an
     *  arbitrary order). 0 pre-mint. */
    sequence: number;
    /** Block at which the Proof was minted; 0 pre-mint. */
    mintedAtBlock: bigint;
    /** Current ERC721 owner. `null` pre-mint; the seller-of-record at
     *  mint time and the current holder are tracked on different rails
     *  — the contribution event is immutable. */
    currentOwner: Address | null;
    /** Decoded SVG markup from the on-chain Proof renderer's
     *  `tokenURI(tokenId)` — the museum-plate inscription (400×500
     *  viewBox) with the isolated trait icon at 8× scale. Reads the
     *  `image` field of the JSON envelope and base64-decodes the inner
     *  SVG data URI. `null` if the renderer isn't reachable (e.g.,
     *  pre-deploy) so the cell falls back to a text-only museum plate. */
    svgMarkup: string | null;
}

/** The acquisition that brought a Proof's trait into the collection,
 *  read from `PermanentCollection.getAcquisitionFor(punkId)`. This is the
 *  provenance backing a Proof: who gave the Punk up (and received the
 *  Proof), what the protocol paid, and when. Immutable once recorded. */
export interface ProofProvenance {
    /** The address that gave up the Punk — the Proof's mint recipient.
     *  For `acceptBid` this is the previous owner; for `acceptListing`
     *  it's the public-listing seller (distinct from the finder). */
    originalSeller: Address;
    /** Who submitted the acceptance tx. Equals `originalSeller` for an
     *  `acceptBid`; differs for an `acceptListing` (the finder). */
    acquirer: Address;
    /** Wei the protocol paid to acquire the Punk (the bounty / listing
     *  price at acceptance). */
    acquisitionPriceWei: bigint;
    /** Block at which the Punk was acquired (return auction opened). */
    acquiredAtBlock: bigint;
    /** Acceptance path, derived from `acquirer === originalSeller`. */
    via: 'acceptBid' | 'acceptListing';
}

/** A single Proof (token id 0..110) with its full mint record AND the
 *  acquisition provenance behind it, for the per-Proof detail page.
 *  `provenance` is `null` when the acquisition record can't be read
 *  (e.g. indexer/fork edge cases) — the page degrades to the mint
 *  record alone. */
export interface ProofDetail extends ProofView {
    provenance: ProofProvenance | null;
}

/** The Vault Title (PunkVault token id 111) — the one-of-one deed for
 *  the whole collection. Surfaced on /proofs and its detail page. */
export interface TitleNftView {
    /** True once the Title has been minted (the auction has settled with a
     *  winner). Pre-mint the Title art still renders (it inscribes the live
     *  collection state) but there is no owner. */
    minted: boolean;
    /** Current ERC721 holder of token 111; `null` pre-mint. */
    owner: Address | null;
    /** Decoded SVG markup from `tokenURI(111)`'s `image` field — the same
     *  on-chain mosaic the homepage shows. `null` if unreachable. */
    svgMarkup: string | null;
}

// ──────────────── Title Auction ────────────────

/** Lifecycle phase the UI renders against. Computed from the underlying
 *  contract booleans + chain time:
 *    - `pre-threshold`     → fewer than `KICKOFF_THRESHOLD` traits collected (=22 at launch)
 *    - `kickoff-ready`     → threshold met, awaiting permissionless kickoff
 *    - `live`              → kickedOff && !settled && now < endsAt
 *    - `settleable`        → kickedOff && !settled && now >= endsAt (with bidder → cleared next; without → restart loop)
 *    - `settled`           → cleared settle has fired; winner holds the Title
 *    - `not-deployed`      → no titleAuction address in config (pre-deploy env)
 */
export type TitleAuctionPhase =
    | 'not-deployed'
    | 'pre-threshold'
    | 'kickoff-ready'
    | 'live'
    | 'settleable'
    | 'settled';

export interface TitleAuctionState {
    phase: TitleAuctionPhase;
    /** Chain `collectedCount` — drives the N/`KICKOFF_THRESHOLD` progress display. */
    collectedCount: number;
    /** True iff the user can call `kickoff()` right now. */
    isKickoffReady: boolean;
    /** True iff the auction is currently accepting bids. */
    isLive: boolean;
    /** True iff `settle()` would succeed right now (block.timestamp >= endsAt). */
    isSettleable: boolean;
    kickedOff: boolean;
    settled: boolean;
    /** 0 pre-kickoff; otherwise the current round's deadline. Updated by
     *  every bid in the snipe window AND every no-bidder restart. */
    endsAt: bigint;
    /** 0 if no bid in the current round. */
    highBidWei: bigint;
    highBidder?: Address;
    /** Minimum acceptable bid right now. 0 pre-kickoff or when no bids
     *  exist (first bid only needs to be non-zero); otherwise
     *  `highBidWei * 1.05` rounded down by integer division. */
    minNextBidWei: bigint;
    /** Number of no-bidder restarts the auction has been through. 0 for
     *  the initial round; 1+ if the auction has looped past one no-bid
     *  deadline. Used to label "Round #N". */
    restartCount: number;
    /** Count of anti-snipe extensions the *current* round has accumulated.
     *  Resets on each Kickoff (initial OR no-bidder restart). */
    extensionsThisRound: number;
    /** Pull-pattern proceeds queue balances. Only meaningful post-settle. */
    pendingProceedsByAddr: {patron: bigint; payoutRecipient: bigint};
    patronAddr: Address;
    payoutRecipientAddr: Address;
    /** Optional refund balance for a specific caller (filled when the UI
     *  passes the connected wallet to the adapter). Pulled via
     *  `withdrawRefund()`. */
    pendingRefundForCaller?: bigint;
}

/** One row per `Bid` event, for the bid-history feed on /title. */
export interface TitleAuctionBidEntry {
    bidder: Address;
    amount: bigint;
    endsAt: bigint;
    extended: boolean;
    blockNumber: bigint;
    timestamp: bigint;
    txHash: Hex;
}

/** One row per accepted bid (`BidPlaced` event) for a given Punk's return
 *  auction, for the bid-history feed on /auction/[punkId]. Indexer-sourced — the
 *  chain-direct `getLogs` path was retired (fan-out + per-viewer cost). */
export interface ReturnAuctionBidEntry {
    bidder: Address;
    amount: bigint;
    blockNumber: bigint;
    timestamp: bigint;
    txHash: Hex;
}

/** Per-referrer status surfaced on the /referral dashboard. The `balance` is
 *  the ledger-side claimable amount — populated automatically by attributed
 *  swaps. `stuckOnHookWei` is the hook's `accruedReferral`, a transient
 *  within-swap accrual the fresh-only settlement flushes by the end of every
 *  swap, so it is normally 0 (the hook holds no balance between swaps). Both
 *  numbers are present so the panel can render its status + "Claim" surface
 *  without a second adapter call. */
export interface ReferralStatus {
    referrer: Address;
    balance: bigint;
    totalCredited: bigint;
    totalClaimed: bigint;
    stuckOnHookWei: bigint;
    lastUpdatedAt?: bigint;
}

// ──────────────── Adapter contract ────────────────

export interface DataAdapter {
    /** Singleton snapshot of headline numbers. */
    getProtocolState(): Promise<ProtocolState>;
    /** How many Punks could accept the live bid right now: carries at least
     *  one uncollected, non-pending trait AND is not already in protocol
     *  custody (in a return auction or vaulted). Computed off the static
     *  10,000-mask dataset + current collected/pending state — no per-Punk
     *  chain reads. `null` when the state can't be sourced (indexer down,
     *  pre-deploy) so callers hide the figure rather than guess. */
    getEligiblePunkCount(): Promise<number | null>;
    /** All 111 traits with current state. */
    getTraitGrid(): Promise<TraitView[]>;
    /** Active return auctions, sorted by soonest close. */
    getActiveAuctions(): Promise<ActiveAuction[]>;
    /** Single auction detail by punkId. */
    getAuctionByPunkId(punkId: number): Promise<AuctionDetail | null>;
    /** The most recent SETTLED return auction for `punkId`, or null if the Punk
     *  has never had one settle. Lets the detail page render the settled outcome
     *  + bid history instead of a not-found state once an auction has closed. */
    getResolvedAuctionByPunkId(punkId: number): Promise<ResolvedAuction | null>;
    /** Recent resolved auctions for the homepage activity feed. */
    getRecentResolutions(limit?: number): Promise<ResolvedAuction[]>;
    /** Recent bounty acceptances. */
    getRecentAcceptedBids(limit?: number): Promise<AcceptedBidEvent[]>;
    /** External market reference; degrades gracefully. */
    getMarketReference(): Promise<MarketReference>;
    /** Public Punk listings the protocol can accept via `Patron.acceptListing`
     *  — sorted cheapest first. PunkStrategy-flavoured at launch (only
     *  allowlisted seller). Iterates the on-chain allowlist so any future
     *  allowlisted seller will appear here too. Empty if bounty < 0.5 ETH or
     *  no listings meet the eligibility rules. */
    getPunkStrategyListings(): Promise<PunkStrategyListing[]>;
    /** Punk eligibility for accept-the-bid. */
    getPunkEligibility(punkId: number, caller?: Address): Promise<PunkEligibility>;
    /** Trait-first acquire view for `owner`'s Punks: every trait the caller can
     *  make permanent (uncollected + non-pending), each with the caller's Punks
     *  that can validly deliver it, annotated with rarity. Rarest-first. The
     *  sole-carrier guard is baked into the aggregation (a unique carrier
     *  appears only under its required trait). Empty if the wallet holds no
     *  eligible Punk. */
    getOwnedTraitOptions(owner: Address): Promise<TraitOption[]>;
    /** Of `punkIds`, which are currently listed exclusively to Patron at a valid
     *  price (the acceptBid pre-listing). Lets the Punk picker mark a Punk the
     *  caller already listed, so a reload mid-flow shows the in-progress state
     *  instead of looking un-started. */
    getPunksListedToPatron(punkIds: number[]): Promise<number[]>;
    /** Per-Punk provenance: this protocol's lifecycle events merged with the
     *  Punk's current public 2017-market listing. Indexer/cache-sourced — never
     *  an all-time market scan. Degrades to an empty timeline if the indexer is
     *  unreachable. */
    getPunkProvenance(punkId: number): Promise<PunkProvenance>;
    /** The on-chain tokenURI's `image` SVG markup (already base64-decoded
     *  on the server). Returns `null` if reading or decoding fails so the
     *  hero falls back to the placeholder. */
    getRendererSvg(): Promise<string | null>;
    /** The Title NFT's `image` SVG markup, decoded from the renderer's
     *  `tokenURI(111)` JSON envelope. Same on-chain mosaic the homepage
     *  shows — the Title (PunkVault token id 111) inscribes the same
     *  artwork that records the collection's state. Returns `null` when
     *  the renderer can't be reached so the Title art falls back to a
     *  quiet placeholder. */
    getTitleSvg(): Promise<string | null>;
    /** All 111 trait names from PunksData (immutable). Indexed by traitId. */
    getTraitNames(): Promise<string[]>;
    /** Pixel data for a single Punk so a client can render the 24×24 sprite.
     *  `indexed` is row-major palette indices (576 bytes); `palette` is the
     *  concatenated RGBA bytes the indices look into. Both come straight
     *  from PunksData. */
    getPunkSprite(punkId: number): Promise<{indexed: Uint8Array; palette: Uint8Array}>;
    /** All Punk ids currently owned by `owner` on the 2017 market. Iterates
     *  `punkIndexToAddress(0..9999)` via Multicall3 — the 2017 contract has
     *  no `balanceOf`/`tokenOfOwnerByIndex`, so enumeration is the only path.
     *  Returns punkIds sorted ascending. Empty array if the wallet holds none. */
    getPunksOwnedBy(owner: Address): Promise<number[]>;
    /** All 111 Proof slots with current mint state. Indexed by tokenId
     *  (1..111). The grid renders each slot — minted Proofs show their
     *  current image; unminted slots show a quiet placeholder. */
    getProofs(): Promise<ProofView[]>;
    /** Single Proof view for a trait. `null` if the Punk hasn't been
     *  vaulted on this trait yet (i.e. no Proof has been minted). */
    getProofForTrait(traitId: number): Promise<ProofView | null>;
    /** A single Proof (token id 0..110) plus the acquisition provenance
     *  behind it, for the per-Proof detail page. `null` if the Proof for
     *  `tokenId` hasn't been minted (so the page can render a "not minted
     *  yet" state). */
    getProofDetail(tokenId: number): Promise<ProofDetail | null>;
    /** The Vault Title (token id 111): mint state, current owner, and the
     *  on-chain art. Always resolves (never throws) so the Title surfaces
     *  pre- and post-mint. */
    getTitleNft(): Promise<TitleNftView>;
    /** Current Title Auction state. `caller` (when passed) is used to
     *  populate `pendingRefundForCaller`. Returns `phase: 'not-deployed'`
     *  with safe defaults when no titleAuction address is configured. */
    getTitleAuctionState(caller?: Address): Promise<TitleAuctionState>;
    /** Append-only bid history for the Title Auction, newest first. */
    getTitleAuctionBids(): Promise<TitleAuctionBidEntry[]>;
    /** Append-only bid history for a Punk's return auction, newest first.
     *  Indexer-sourced — the previous chain-direct `getLogs` approach
     *  fanned out across every viewer of /auction/[punkId]. */
    getReturnAuctionBids(punkId: number): Promise<ReturnAuctionBidEntry[]>;
    /** Per-referrer ledger + transient hook accrual. Indexer reads
     *  `Referrer.balance` (server of truth, no chain call); the
     *  `stuckOnHookWei` field still requires a chain read because the
     *  hook's `accruedReferral` is state-only (no event). Both fold into a
     *  single response so the dashboard doesn't have to multiplex two
     *  adapter calls. */
    getReferralStatus(referrer: Address): Promise<ReferralStatus>;
}
