import type {Metadata} from 'next';
import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {getTokenTicker, isProtocolLive} from '@/lib/config';
import {buildMeta} from '@/lib/meta';
import {
    ANTI_SNIPER,
    AUCTION,
    CLEARED_SPLIT,
    COLLECTION,
    FEES,
    FINDER,
    TITLE,
    fmtPct,
} from '@/lib/protocol-params';

/* Protocol: the full system walkthrough. Pool + hook, fee routing,
   live bid, return auction, vault, phase routing, records, contracts,
   invariants. Three inline-SVG diagrams (architecture + fee routing +
   auction lifecycle) carry the visual weight; the rest is structured
   prose in the same labeled-section layout as /about. Contract addresses
   are listed as names only pre-launch (no deployment yet); once contracts
   land the addresses + evm.now links go in next to each name.

   Every fee number, duration, and percentage comes from
   `@/lib/protocol-params` so site-wide changes happen in one place.

   Copy follows docs/LANGUAGE_STYLE_GUIDE.md and the user's voice rules
   (contractions, no bullet periods, no dashes in text). */

const TICKER = getTokenTicker();

export const metadata: Metadata = buildMeta({
    title: 'Protocol · Permanent Collection',
    description:
        'A walk-through of the system: the pool, the hook, the live bid, the return auction, the vault, and the invariants that make the work durable.',
    path: '/protocol',
});

export default function ProtocolPage() {
    // Pre-deploy: show contract names instead of (not-yet-existent) addresses.
    const previewMode = !isProtocolLive();
    return (
        <>
            <Header />
            <main id="top">
                <section className="protocol-hero" aria-label="Protocol overview">
                    <div className="wrap">
                        <div className="kicker">Protocol</div>
                        <h1 className="protocol-h1">The mechanism in detail.</h1>
                        <p className="protocol-lede">
                            Permanent Collection moves through three motions. Trading feeds
                            a live bid. An eligible Punk accepts. A {AUCTION.durationHours}-hour return auction
                            decides whether the Punk returns to circulation or enters the
                            vault. This page walks through each motion, the contracts behind
                            them, and the invariants that make the work durable.
                        </p>
                    </div>
                </section>

                <ProtocolSection label="Architecture">
                    <p>
                        Permanent Collection sits on top of the artcoins protocol.
                        Artcoins handles the token deploy, the V4 pool, the hook, the LP
                        locker, and the MEV module. PC adds the live bid, the return
                        auction, the vault, and the rendering stack that turns vault state
                        into on-chain art. PunksData is the sealed external source for
                        trait names and pixel data; Punks is the canonical 2017
                        market where vaulted Punks actually live, at PunkVault&apos;s
                        address.
                    </p>
                    <ArchitectureDiagram />
                </ProtocolSection>

                <ProtocolSection label="The official pool">
                    <p>
                        {TICKER} pairs with native ETH in a Uniswap V4 pool. Total fee
                        on every swap is {fmtPct(FEES.totalSwapFeePct)}:{' '}
                        {fmtPct(FEES.lpFeePct)} is the V4 LP fee paid to liquidity
                        providers via the standard mechanism, plus{' '}
                        {fmtPct(FEES.baselineSkimPct)} is a baseline skim the hook splits
                        inside the same transaction. The split happens before the user
                        sees the result; there&apos;s no separate router and no off-chain
                        collection.
                    </p>
                    <p>
                        At launch the LP fee also feeds the live bid: an LP locker
                        holds 100% of LP positions and routes its single reward slot
                        to FeeAutoSwapper, which converts the {TICKER} side to ETH
                        and forwards it to LiveBidAdapter. The reward slot is
                        admin-locked to a dead address so it can&apos;t be redirected.
                        Public LPs can mint positions after the anti-sniper window and
                        earn their pro-rata share alongside the locker.
                    </p>
                    <p>
                        For the first ~{ANTI_SNIPER.durationMin} minutes after launch,
                        the pool runs an anti-sniper window. The fee starts at{' '}
                        {fmtPct(ANTI_SNIPER.peakPct)} and decays linearly to{' '}
                        {fmtPct(ANTI_SNIPER.baselinePct)} at{' '}
                        {fmtPct(ANTI_SNIPER.decayPctPerMin)} per minute. Everything above
                        the {fmtPct(ANTI_SNIPER.baselinePct)} baseline routes 100% to
                        the live bid; the baseline split below is what runs forever.
                    </p>
                </ProtocolSection>

                <ProtocolSection label="Fee routing">
                    <p>
                        Of the {fmtPct(FEES.baselineSkimPct)} baseline skim, three legs
                        route inside the same swap through dedicated adapters, each to a
                        fixed destination from block one. The bid leg routes to Patron
                        (the live bid). The protocol leg routes to PCController. The
                        referral leg, when a swap carries an attribution payload, routes a
                        thin slice from the protocol leg to the named referrer.
                    </p>
                    <FeeRoutingDiagram />
                    <ul className="protocol-bullets">
                        <li>
                            <strong>{fmtPct(FEES.bidLegPct)} → LiveBidAdapter:</strong>{' '}
                            always routes to Patron (the live bid). The adapter meters it
                            in two modes: below an activation threshold it fills the bid
                            fast (the launch warm-up); above it a rate cap throttles, so a
                            single big swap can&apos;t flood the bid in one block
                        </li>
                        <li>
                            <strong>{fmtPct(FEES.protocolLegPct)} → ProtocolFeePhaseAdapter:</strong>{' '}
                            sweeps to PCController from block one, which splits{' '}
                            {fmtPct(FEES.pcTreasuryPct)} to the PC treasury and{' '}
                            {fmtPct(FEES.layerBurnPct)} to the $LAYER buy-and-burn
                        </li>
                        <li>
                            <strong>Up to {fmtPct(FEES.referralCapPct)} → ReferralPayout:</strong>{' '}
                            if a swap carries a {`PCAttribution`} payload, a thin slice
                            routes from the protocol leg to the named referrer, from the
                            first swap. The referrer pulls from a per-address ledger. With
                            no referrer the slice stays in the protocol leg
                        </li>
                        <li>
                            <strong>{fmtPct(FEES.lpFeePct)} LP fee → liquidity
                            providers:</strong> paid via V4&apos;s standard mechanism,
                            not the hook. At launch the LP locker holds 100% of LP
                            positions and routes its share through FeeAutoSwapper
                            (which converts the {TICKER} side to ETH) to
                            LiveBidAdapter, so the LP fee effectively joins the live
                            bid until public LPs add depth
                        </li>
                    </ul>
                </ProtocolSection>

                <ProtocolSection label="The live bid">
                    <p>
                        Patron holds the live bid as native ETH. The bid is an
                        accounted total, <code>bidBalance()</code>, that only fills
                        through LiveBidAdapter: Patron&apos;s <code>receive()</code>{' '}
                        rejects every other sender, and ETH forced in by any other
                        route never counts toward the bid. The number on the homepage
                        is <code>bidBalance()</code>.
                    </p>
                    <p>
                        Any address can top up the live bid by sending ETH to the
                        LiveBidAdapter, which meters it into Patron. To accept the bid,
                        the owner of an eligible Punk first lists it exclusively to
                        Patron at a price at or below the live bid (the frontend defaults
                        to the full bid), then anyone can finalize the acceptance by
                        calling <code>acceptBid</code>. Anyone can call{' '}
                        <code>acceptListing</code> against an allowlisted listing contract
                        (see below).
                    </p>
                    <p>
                        Patron buys the Punk at the listed price, so the canonical 2017
                        market pays the seller: the proceeds queue in the market&apos;s{' '}
                        <code>pendingWithdrawals</code> and the seller collects them with{' '}
                        <code>withdraw()</code>. The Punk transfers to ReturnAuctionModule
                        and the {AUCTION.durationHours}-hour return auction opens.
                    </p>
                </ProtocolSection>

                <ProtocolSection label="Listings from other protocols">
                    <p>
                        Some Punks sit inside autonomous protocols rather than at an
                        owner&apos;s wallet. <strong>PunkStrategy</strong> (PNKSTR) is
                        the canonical example: it buys floor Punks and immediately
                        re-lists them at 1.2× cost on the 2017 Punks market;
                        when one of those listings sells, PunkStrategy uses the
                        proceeds to buy and burn PNKSTR. The Punks pass through the
                        contract on a fixed-flow yoyo.
                    </p>
                    <p>
                        Permanent Collection has a custom path for protocols like
                        this: any address can call <code>acceptListing</code> against
                        an allowlisted listing contract whose published price is at
                        or below the live bid, bridging the trade in one transaction.
                        PunkStrategy receives its 1.2× and triggers its own
                        buy-and-burn cycle; PC takes custody of the Punk and opens
                        the same {AUCTION.durationHours}-hour return auction. Both
                        protocols&apos; cycles complete on the same swap.
                    </p>
                    <p>
                        The caller earns a small finder fee — a share of the live-bid
                        balance, not the listing price: {fmtPct(FINDER.feePctOfBid)} of the
                        live bid, hard-capped at {FINDER.feeFixedCapEth} ETH. The{' '}
                        <code>acceptListing</code> path only opens once the live bid is at
                        least {FINDER.minBidForListingEth} ETH.
                    </p>
                    <p>
                        At launch the allowlist seeds PunkStrategy only.{' '}
                        <code>Patron.addAllowedSeller</code> stays editable past the
                        protocol&apos;s 1-year admin auto-lock (one of the four
                        scoped carve-outs) so new peer protocols can be registered as
                        they emerge. Any contract that lists Punks via the canonical
                        2017 market&apos;s <code>offerPunkForSale</code> surface is
                        eligible; the allowlist gates which ones PC is willing to
                        source from. The mechanism on the caller side is
                        permissionless.
                    </p>
                </ProtocolSection>

                <ProtocolSection label="The return auction">
                    <p>
                        Once a Punk is in the return auction, anyone can bid at or
                        above the reserve to return it to circulation. The reserve is
                        set at acceptance time
                        from the acquisition cost and the number of times the protocol
                        has already tried for that trait:{' '}
                        <code>cost × (101 + previousAttempts) / 100</code>, rounded up.
                        First attempt for a trait reserves at 1.01× cost; each subsequent
                        attempt against the same trait adds 1%.
                    </p>
                    <p>
                        Bids in the last {AUCTION.snipeExtensionTriggerMin} minutes
                        extend the auction by {AUCTION.snipeExtensionGainHours} hour.
                        There is no cap on extensions. The auction either clears (a bid
                        lands above the reserve) or it doesn&apos;t.
                    </p>
                    <AuctionLifecycleDiagram />
                    <p>
                        On clear, the high bidder takes the Punk. The acquisition cost
                        splits three ways: {fmtPct(CLEARED_SPLIT.liveBidPct)} refills the
                        live bid via LiveBidAdapter, {fmtPct(CLEARED_SPLIT.buybackBurnPct)} buys
                        back and burns {TICKER} via BuybackBurner, and{' '}
                        {fmtPct(CLEARED_SPLIT.vaultBurnPct)} goes to the vault burn pool.
                        Any premium the high bid carries above cost also routes to the
                        vault burn pool — minus up to{' '}
                        {fmtPct(CLEARED_SPLIT.referrerPremiumPct)} of that premium to the
                        winning bid&apos;s referrer, if one is attributed. The vault burn
                        pool sweeps to BuybackBurner on the next vaulted settle.
                    </p>
                    <p>
                        On silence (no bid by the deadline), the Punk transfers to
                        PunkVault. The chosen trait flips from pending to permanent on
                        PermanentCollection. A Proof NFT mints to the original seller.
                        The vault burn pool sweeps on the same settle, feeding any
                        accumulated premium into the buyback.
                    </p>
                </ProtocolSection>

                <ProtocolSection label="The vault">
                    <p>
                        PunkVault is the immutable custody contract. It has no transfer,
                        withdraw, rescue, or sweep selector. This is asserted at the
                        bytecode level: the deployed contract&apos;s selector table is
                        scanned by a fork test that fails if any market-write or
                        admin-exit pattern appears.
                    </p>
                    <p>
                        The vault is also the issuer of{' '}
                        {COLLECTION.proofTokenCount + 1} named tokens. Token id{' '}
                        {COLLECTION.titleTokenId} is the Vault Title, auctioned through{' '}
                        <code>PunkVaultTitleAuction</code> once{' '}
                        {TITLE.kickoffThreshold} of {COLLECTION.totalTraits} traits are
                        collected. Token ids 0..{COLLECTION.proofTokenCount - 1} are the{' '}
                        {COLLECTION.proofTokenCount} Proofs, one per trait, minted on
                        first-vaulting to the original seller. The Title and the Proofs
                        are ERC721 and freely transferable; the Punks themselves are not
                        ERC721 and live at the canonical 2017 Punks contract.
                    </p>
                    <p>
                        Title grants no withdrawal rights, no admin control, no governance,
                        and no claim on the Punks. It&apos;s a stewardship record, named
                        in the contract for display purposes only.
                    </p>
                </ProtocolSection>

                <ProtocolSection label="Records">
                    <p>
                        Every acceptance appends a row to{' '}
                        <code>PermanentCollection.Acquisition[]</code>. The log records
                        the Punk id, the chosen trait, the pending-mask snapshot at
                        acquisition, the acquirer, the original seller, the price paid,
                        and the block. Rows never delete and never reorder. Custody on
                        each row moves forward only: from <code>InReturnAuction</code> to
                        either <code>ReturnedToMarket</code> or <code>Vaulted</code>, then
                        freezes.
                    </p>
                    <p>
                        Acquisition isn&apos;t the same as collection. The trait bitmap{' '}
                        (<code>collectedMask</code>) only flips a bit when a Punk
                        actually enters the vault carrying that trait, and only for the
                        recorded target trait, not for every uncollected bit on the
                        Punk&apos;s mask.
                    </p>
                    <p>
                        Proofs encode that record as art. Each Proof carries the Punk id,
                        the trait id, the sequence (Nth Proof minted), and the
                        vault-settle block. The metadata is frozen at mint time and
                        survives transfer.
                    </p>
                </ProtocolSection>

                <ProtocolSection label="Composability">
                    <p>
                        Two builder surfaces are live from day one:
                    </p>
                    <ul className="protocol-bullets">
                        <li>
                            <strong>Attribution:</strong> every swap can carry a{' '}
                            <code>sourceId</code> and <code>referrer</code> field via
                            hookData. The official hook emits a{' '}
                            <code>SwapAttribution</code> event for every attributed swap.
                            Permissionless, no allowlist
                        </li>
                        <li>
                            <strong>Referral fee:</strong> up to{' '}
                            {fmtPct(FEES.referralCapPct)} of swap volume can flow to the
                            referrer on every attributed swap, pulled from the protocol
                            slice. The live bid stays structurally untouched
                        </li>
                    </ul>
                </ProtocolSection>

                <ProtocolSection label="Contracts">
                    <p>
                        The full system is below. {previewMode
                            ? 'Addresses fill in here once the protocol deploys to mainnet.'
                            : 'Each name links to the deployed contract on evm.now.'}{' '}
                        The source for every contract is public:{' '}
                        <a
                            href="https://github.com/ripe0x/permanent-collection"
                            target="_blank"
                            rel="noreferrer"
                        >
                            github.com/ripe0x/permanent-collection
                        </a>{' '}
                        holds the protocol, and{' '}
                        <a
                            href="https://github.com/ripe0x/artcoins"
                            target="_blank"
                            rel="noreferrer"
                        >
                            github.com/ripe0x/artcoins
                        </a>{' '}
                        holds the launcher it runs on (hook, factory, lockers).
                    </p>

                    <h3 className="protocol-h3">Permanent core</h3>
                    <ContractList
                        previewMode={previewMode}
                        items={[
                            {name: 'PermanentCollection', note: 'Append-only acquisition log and the collected-trait bitmap. No funds, no Punks'},
                            {name: 'Patron', note: 'Live-bid ETH hub. Entry point for acceptBid and acceptListing'},
                            {name: 'ReturnAuctionModule', note: `${AUCTION.durationHours}-hour return auction. Settles cleared or vaulted`},
                            {name: 'ReturnAuctionEscrow', note: 'Settlement escrow tied to ReturnAuctionModule by construction'},
                            {name: 'PunkVault', note: `Immutable custody. ERC721 issuer for the Title and the ${COLLECTION.proofTokenCount} Proofs`},
                            {name: 'BuybackBurner', note: `Paced buy-and-burn of ${TICKER} from cleared-auction revenue and vault-burn-pool sweeps`},
                            {name: 'VaultBurnPool', note: 'Accumulator for the auction premium above cost. Flushes to BuybackBurner on every vaulted settle'},
                            {name: 'ProtocolAdmin', note: '1-year auto-locking admin role over a handful of economic parameters'},
                        ]}
                    />

                    <h3 className="protocol-h3">Fee adapters</h3>
                    <ContractList
                        previewMode={previewMode}
                        items={[
                            {name: 'LiveBidAdapter', note: `${fmtPct(FEES.bidLegPct)} bid leg plus the LP fee. Sweeps 100% to Patron`},
                            {name: 'ProtocolFeePhaseAdapter', note: `${fmtPct(FEES.protocolLegPct)} protocol leg. Sweeps to PCController from block 1, which splits ${fmtPct(FEES.pcTreasuryPct)} to the PC treasury and ${fmtPct(FEES.layerBurnPct)} to the LAYER burn`},
                            {name: 'ReferralPayout', note: 'Per-address pull ledger for the referral slice'},
                        ]}
                    />

                    <h3 className="protocol-h3">Composability and admin</h3>
                    <ContractList
                        previewMode={previewMode}
                        items={[
                            {name: 'PCSwapContext', note: 'Transient-storage reentrancy registry shared across PC contracts'},
                            {name: 'TokenAdminPoker', note: `Holds the ${TICKER} tokenAdmin role. Exposes the bind-extension safety valve`},
                        ]}
                    />

                    <h3 className="protocol-h3">Renderer</h3>
                    <ContractList
                        previewMode={previewMode}
                        items={[
                            {name: 'PermanentCollectionMosaicRenderer', note: `Renders the Title (token ${COLLECTION.titleTokenId}) and dispatches Proof renders to the Proof renderer`},
                            {name: 'PermanentCollectionProofRenderer', note: `Per-Proof renderer for token ids 0..${COLLECTION.proofTokenCount - 1}`},
                            {name: 'RendererRegistry', note: 'Stable address fronting the live renderer. Swappable until frozen'},
                            {name: 'PunkVaultTitleAuction', note: `Kickoff plus auction for the Vault Title once ${TITLE.kickoffThreshold} traits are collected`},
                        ]}
                    />
                </ProtocolSection>

                <ProtocolSection label="Invariants">
                    <p>
                        These are the durability claims the protocol holds. Each is
                        enforced at the bytecode level (selector scans) or via the
                        adversarial fork test suite. None of them can be loosened without
                        a redeploy:
                    </p>
                    <ul className="protocol-bullets">
                        <li>
                            <code>collectedMask</code> is monotonically increasing. Bits
                            never unset
                        </li>
                        <li>
                            <code>Acquisition[]</code> only grows. Rows never delete or
                            reorder; only the custody field mutates forward
                        </li>
                        <li>
                            Custody transitions are strictly{' '}
                            <code>InReturnAuction → ReturnedToMarket | Vaulted</code>, then
                            frozen
                        </li>
                        <li>
                            Acquisition does not imply collection.{' '}
                            <code>recordAcquisition</code> never touches{' '}
                            <code>collectedMask</code>; only{' '}
                            <code>markCustody(Vaulted)</code> does
                        </li>
                        <li>
                            Vaulted collects only the recorded target trait, not every
                            uncollected bit on the Punk&apos;s mask
                        </li>
                        <li>
                            No Punk can leave PunkVault or PermanentCollection. Neither
                            contract holds a Punks market-write selector
                        </li>
                        <li>
                            The cleared-path proceeds split is hard-coded:{' '}
                            <code>CLEARED_BID_BPS = 6500</code>. No setter, no admin override
                        </li>
                        <li>
                            <code>address(patron).balance &gt;= bidBalance()</code>. The
                            bid only fills through LiveBidAdapter; ETH forced in by any
                            other route never counts toward it
                        </li>
                        <li>
                            Token holders have no governance over the protocol
                        </li>
                        <li>
                            The {fmtPct(FEES.baselineSkimPct)} baseline skim split is
                            enforced at swap-time inside the hook, not collected post-hoc
                        </li>
                    </ul>
                </ProtocolSection>
            </main>
            <Footer />
            <style>{styles}</style>
        </>
    );
}

function ProtocolSection({label, children}: {label: string; children: React.ReactNode}) {
    return (
        <section className="protocol-section" aria-label={label}>
            <div className="wrap protocol-grid">
                <div className="protocol-sec-label">{label}</div>
                <div className="protocol-sec-body">{children}</div>
            </div>
        </section>
    );
}

function ContractList({
    items,
    previewMode,
}: {
    items: {name: string; note: string}[];
    previewMode: boolean;
}) {
    return (
        <ul className="protocol-contracts">
            {items.map((c) => (
                <li key={c.name} className="protocol-contract">
                    <span className="protocol-contract-name">{c.name}</span>
                    <span className="protocol-contract-note">{c.note}</span>
                    {!previewMode && (
                        <span className="protocol-contract-addr">
                            {/* Address fills in post-deploy. Render as a link to evm.now
                                when the address becomes available. */}
                        </span>
                    )}
                </li>
            ))}
        </ul>
    );
}

/* ─────────────────────────────────────────────────────────────────
   Architecture diagram. Three-band stack:
     1. External anchors (CryptoPunks market + PunksData)
     2. Artcoins infrastructure (the factory deploys the token +
        pool; the hook, locker, MEV module, and escrow deploy
        alongside it and are bound to it)
     3. Permanent Collection (adapters + patron + vault) plus the
        rendering stack (Registry + Mosaic + Proof + caches), with
        an arrow showing the renderers reading PunksData
   ───────────────────────────────────────────────────────────────── */
function ArchitectureDiagram() {
    /* Layout constants. Boxes use generous vertical padding so text
       doesn't touch the edges. Each band sits in a vertical lane with
       a band label on the far left. */
    const BOX_PAD_Y = 14;
    return (
        <figure
            className="protocol-diagram"
            aria-label="Diagram: artcoins infrastructure, PC protocol contracts (Patron, ReturnAuctionModule, PunkVault each shown separately), the rendering stack, and the external anchors at the bottom"
        >
            <svg
                role="img"
                viewBox="0 0 920 800"
                preserveAspectRatio="xMidYMid meet"
                xmlns="http://www.w3.org/2000/svg"
            >
                <defs>
                    <marker
                        id="arrow-arch"
                        viewBox="0 0 10 10"
                        refX="9"
                        refY="5"
                        markerWidth="6"
                        markerHeight="6"
                        orient="auto-start-reverse"
                    >
                        <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                    </marker>
                </defs>

                {/* Band dividers (subtle) */}
                <g stroke="currentColor" strokeWidth="0.5" opacity="0.18">
                    <line x1="160" y1="350" x2="900" y2="350" />
                    <line x1="160" y1="570" x2="900" y2="570" />
                    <line x1="160" y1="690" x2="900" y2="690" />
                </g>

                {/* ─── Band 1: Artcoins infrastructure ─────────────── */}
                <g fill="none" stroke="currentColor" strokeWidth="1">
                    {/* Factory at the top center */}
                    <rect x="370" y="20" width="220" height="64" rx="2" />

                    {/* Fan-out lines */}
                    <line x1="480" y1="84" x2="480" y2="110" />
                    <line x1="180" y1="110" x2="780" y2="110" />
                    <line x1="180" y1="110" x2="180" y2="134" markerEnd="url(#arrow-arch)" />
                    <line x1="380" y1="110" x2="380" y2="134" markerEnd="url(#arrow-arch)" />
                    <line x1="580" y1="110" x2="580" y2="134" markerEnd="url(#arrow-arch)" />
                    <line x1="780" y1="110" x2="780" y2="134" markerEnd="url(#arrow-arch)" />

                    {/* Deployed boxes — taller (h=96) so 3 lines have padding */}
                    <rect x="100" y="134" width="160" height="96" rx="2" />
                    <rect x="300" y="134" width="160" height="96" rx="2" />
                    <rect x="500" y="134" width="160" height="96" rx="2" />
                    <rect x="700" y="134" width="160" height="96" rx="2" />
                </g>
                <g
                    fontFamily="var(--mono)"
                    fill="currentColor"
                    textAnchor="middle"
                >
                    <text x="480" y="50" fontSize="13">
                        ArtCoinsFactory
                    </text>
                    <text x="480" y="68" fontSize="11" opacity="0.7">
                        deploys + binds, owner-only
                    </text>

                    {/* Box 1: 111. Sub-labels drop to fontSize 10 so the
                        longer contract names in box 3/4 don't overflow the
                        160-wide boxes — kept uniform across the row for
                        consistency. */}
                    <text x="180" y="164" fontSize="12">
                        {getTokenTicker()}
                    </text>
                    <text x="180" y="184" fontSize="10" opacity="0.7">
                        ERC20 artcoin
                    </text>
                    <text x="180" y="204" fontSize="10" opacity="0.55">
                        tokenURI renders the work
                    </text>

                    {/* Box 2: V4 Pool */}
                    <text x="380" y="164" fontSize="12">
                        V4 Pool
                    </text>
                    <text x="380" y="184" fontSize="10" opacity="0.7">
                        {getTokenTicker()} / ETH
                    </text>
                    <text x="380" y="204" fontSize="10" opacity="0.55">
                        {fmtPct(FEES.lpFeePct)} LP + {fmtPct(FEES.baselineSkimPct)} skim
                    </text>

                    {/* Box 3: Hook + MEV */}
                    <text x="580" y="164" fontSize="12">
                        Hook + MEV
                    </text>
                    <text x="580" y="184" fontSize="10" opacity="0.7">
                        HookSkimFee + LinearSkim
                    </text>
                    <text x="580" y="204" fontSize="10" opacity="0.55">
                        anti-sniper window
                    </text>

                    {/* Box 4: Locker + Escrow */}
                    <text x="780" y="164" fontSize="12">
                        Locker + Escrow
                    </text>
                    <text x="780" y="184" fontSize="10" opacity="0.7">
                        ArtCoinsLpLocker
                    </text>
                    <text x="780" y="204" fontSize="10" opacity="0.55">
                        FeeEscrow buffers claims
                    </text>
                </g>

                {/* ─── Band 2: PC protocol ─────────────────────────────
                    Layout: fee adapters (full width) on top, then three
                    individual boxes for Patron / ReturnAuctionModule /
                    PunkVault in a row showing the actual protocol flow. */}
                <g fill="none" stroke="currentColor" strokeWidth="1">
                    {/* Fees from Hook + Locker down into adapters. The locker
                        leg passes through FeeAutoSwapper (labeled on the line),
                        which converts the artcoin side to ETH before it reaches
                        LiveBidAdapter. */}
                    <line x1="580" y1="230" x2="580" y2="382" markerEnd="url(#arrow-arch)" />
                    <line x1="780" y1="230" x2="780" y2="372" />
                    <line x1="580" y1="372" x2="780" y2="372" />

                    {/* Fee adapters box (wide, full grid width) */}
                    <rect x="80" y="382" width="760" height="60" rx="2" />

                    {/* Adapters → Patron (down arrow over Patron's x-center) */}
                    <line x1="200" y1="442" x2="200" y2="478" markerEnd="url(#arrow-arch)" />

                    {/* Three individual PC core boxes in a row */}
                    <rect x="80" y="478" width="240" height="88" rx="2" />
                    <rect x="340" y="478" width="240" height="88" rx="2" />
                    <rect x="600" y="478" width="240" height="88" rx="2" />

                    {/* Horizontal arrows: Patron → RA → Vault */}
                    <line x1="320" y1="522" x2="340" y2="522" markerEnd="url(#arrow-arch)" />
                    <line x1="580" y1="522" x2="600" y2="522" markerEnd="url(#arrow-arch)" />
                </g>
                <g
                    fontFamily="var(--mono)"
                    fill="currentColor"
                    textAnchor="middle"
                >
                    <text x="460" y="410" fontSize="12">
                        Fee adapters
                    </text>
                    <text x="460" y="430" fontSize="11" opacity="0.7">
                        LiveBid · ProtocolFee · Referral
                    </text>
                    <text x="790" y="300" fontSize="10" opacity="0.55" textAnchor="start">
                        via FeeAutoSwapper
                    </text>

                    {/* Patron */}
                    <text x="200" y="506" fontSize="13">
                        Patron
                    </text>
                    <text x="200" y="526" fontSize="11" opacity="0.7">
                        live-bid ETH hub
                    </text>
                    <text x="200" y="548" fontSize="10" opacity="0.55">
                        acceptBid / acceptListing
                    </text>

                    {/* ReturnAuctionModule */}
                    <text x="460" y="506" fontSize="13">
                        ReturnAuctionModule
                    </text>
                    <text x="460" y="526" fontSize="11" opacity="0.7">
                        {AUCTION.durationHours}-hour auction
                    </text>
                    <text x="460" y="548" fontSize="10" opacity="0.55">
                        cleared or vaulted
                    </text>

                    {/* PunkVault */}
                    <text x="720" y="506" fontSize="13">
                        PunkVault
                    </text>
                    <text x="720" y="526" fontSize="11" opacity="0.7">
                        immutable custody
                    </text>
                    <text x="720" y="548" fontSize="10" opacity="0.55">
                        ERC721 issuer (Title + Proofs)
                    </text>
                </g>

                {/* Tiny accept / settle labels above the horizontal arrows */}
                <g
                    fontFamily="var(--mono)"
                    fill="currentColor"
                    textAnchor="middle"
                    fontSize="9"
                    opacity="0.55"
                    letterSpacing="0.06em"
                >
                    <text x="330" y="516">accept</text>
                    <text x="590" y="516">settle</text>
                </g>

                {/* ─── Band 3: Rendering ─────────────────────────────── */}
                <g fill="none" stroke="currentColor" strokeWidth="1">
                    {/* PunkVault → rendering row.
                        Curve down-left from PunkVault box at (720, 566)
                        to NFTs box at (260, 606). */}
                    <path
                        d="M 720 566 C 720 596 560 596 260 606"
                        markerEnd="url(#arrow-arch)"
                    />

                    {/* Rendering row — taller boxes (h=76) for padding. The
                        Caches box widens to 140 (touching the viewBox right at
                        x=920) so "PunkSvg + TraitIcon" gets symmetric ~13px
                        padding instead of the 3px it had at width 120. */}
                    <rect x="180" y="606" width="160" height="76" rx="2" />
                    <rect x="380" y="606" width="160" height="76" rx="2" />
                    <rect x="580" y="606" width="160" height="76" rx="2" />
                    <rect x="780" y="606" width="140" height="76" rx="2" />

                    {/* Chain arrows between renderer boxes */}
                    <line x1="340" y1="644" x2="380" y2="644" markerEnd="url(#arrow-arch)" />
                    <line x1="540" y1="644" x2="580" y2="644" markerEnd="url(#arrow-arch)" />
                    <line x1="740" y1="644" x2="780" y2="644" markerEnd="url(#arrow-arch)" />
                </g>
                <g
                    fontFamily="var(--mono)"
                    fill="currentColor"
                    textAnchor="middle"
                >
                    {/* Sub-labels at fontSize 10 across the row so the
                        narrowest box (Caches, 120 wide) doesn't overflow
                        on "PunkSvg + TraitIcon" — at fontSize 11 the text
                        is 125 px wide and overflows the box. */}
                    <text x="260" y="636" fontSize="12">
                        PunkVault NFTs
                    </text>
                    <text x="260" y="656" fontSize="10" opacity="0.7">
                        Title + {COLLECTION.proofTokenCount} Proofs
                    </text>

                    <text x="460" y="636" fontSize="12">
                        RendererRegistry
                    </text>
                    <text x="460" y="656" fontSize="10" opacity="0.7">
                        stable front address
                    </text>

                    <text x="660" y="636" fontSize="12">
                        MosaicRenderer
                    </text>
                    <text x="660" y="656" fontSize="10" opacity="0.7">
                        Title + ProofRenderer
                    </text>

                    <text x="850" y="636" fontSize="12">
                        Caches
                    </text>
                    <text x="850" y="656" fontSize="10" opacity="0.7">
                        PunkSvg + TraitIcon
                    </text>
                </g>

                {/* ─── Band 4: External anchors (bottom) ──────────────── */}
                <g fill="none" stroke="currentColor" strokeWidth="1">
                    <rect x="180" y="708" width="240" height="84" rx="2" />
                    <rect x="500" y="708" width="240" height="84" rx="2" />
                </g>
                <g
                    fontFamily="var(--mono)"
                    fill="currentColor"
                    textAnchor="middle"
                >
                    <text x="300" y="736" fontSize="13">
                        Punks market
                    </text>
                    <text x="300" y="756" fontSize="11" opacity="0.7">
                        canonical 2017 contract
                    </text>
                    <text x="300" y="776" fontSize="10" opacity="0.55">
                        vaulted Punks live at PunkVault address
                    </text>

                    <text x="620" y="736" fontSize="13">
                        PunksData
                    </text>
                    <text x="620" y="756" fontSize="11" opacity="0.7">
                        sealed, canonical
                    </text>
                    <text x="620" y="776" fontSize="10" opacity="0.55">
                        trait names + per-Punk pixels
                    </text>
                </g>

                {/* Dashed dependency arrows (both go DOWN). Routed on
                    the outer edges so they don't collide with the
                    central PC / rendering arrows. */}
                <g fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" opacity="0.6">
                    {/* PunkVault (PC band) → CryptoPunks market.
                        Route via the far-left edge: down from PunkVault,
                        out left around the rendering band, into
                        CryptoPunks market. */}
                    <path d="M 600 540 C 60 580 60 690 300 708" markerEnd="url(#arrow-arch)" />

                    {/* Caches (rendering band) → PunksData. Short
                        downward curve from the new (wider) Caches box's
                        bottom-center at (850, 682). */}
                    <path d="M 850 682 C 880 700 700 700 620 708" markerEnd="url(#arrow-arch)" />
                </g>
                <g fontFamily="var(--mono)" fill="currentColor" opacity="0.7" fontSize="10">
                    {/* "holds Punks" sits in the gap between the rendering band
                        boxes (end y=682) and the external band boxes (start
                        y=708), near where the dashed curve bends right toward
                        CryptoPunks market. Clear of every band label and box. */}
                    <text x="180" y="698" textAnchor="start">
                        holds Punks
                    </text>
                    <text x="880" y="694" textAnchor="end">
                        reads trait data
                    </text>
                </g>
            </svg>
            <figcaption className="protocol-diagram-caption">
                Architecture: the artcoins factory deploys {getTokenTicker()} and the
                V4 pool, with the hook, locker, and MEV module bound to it; PC adds
                the live bid (Patron), the return auction (ReturnAuctionModule), the
                vault (PunkVault), and the renderer stack; the bottom band is the
                external contracts everything else depends on.
            </figcaption>
        </figure>
    );
}

/* ─────────────────────────────────────────────────────────────────
   Fee routing diagram. Shows the 6% baseline skim splitting three ways
   at swap-time, with the destination for each leg. Inline SVG so
   the diagram lives with the page text and doesn't need a separate
   asset. Scales with its container; uses CSS variables for color so
   it tracks the site theme.
   ───────────────────────────────────────────────────────────────── */
function FeeRoutingDiagram() {
    /* Same padding standard as the other diagrams: 2-line boxes use
       h=72 with text baselines at y0+28 and y0+50 so each line sits
       18-20px from the box edges. */
    return (
        <figure className="protocol-diagram" aria-label="Diagram: the 6% baseline skim splits at swap-time into a bid leg and a protocol leg, with the referral slice carved from the protocol leg">
            <svg
                role="img"
                viewBox="0 0 720 380"
                preserveAspectRatio="xMidYMid meet"
                xmlns="http://www.w3.org/2000/svg"
            >
                <defs>
                    <marker
                        id="arrow"
                        viewBox="0 0 10 10"
                        refX="9"
                        refY="5"
                        markerWidth="6"
                        markerHeight="6"
                        orient="auto-start-reverse"
                    >
                        <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                    </marker>
                </defs>

                <g
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1"
                    className="protocol-diagram-strokes"
                >
                    {/* Top source box (2-line, h=72) */}
                    <rect x="280" y="20" width="160" height="72" rx="2" />

                    {/* Trunk arrow */}
                    <line x1="360" y1="92" x2="360" y2="124" markerEnd="url(#arrow)" />

                    {/* Two-way fan-out (bid + protocol). The referral slice is
                        carved FROM the protocol leg inside the hook, so its
                        branch leaves the protocol leg's vertical (not the
                        trunk); a third trunk slice would misread as
                        5% + 1% + 0.25% of volume.
                        Columns at x=80 (bid), x=360 (protocol), x=640 (referral). */}
                    <line x1="80" y1="124" x2="360" y2="124" />
                    <line x1="80" y1="124" x2="80" y2="164" markerEnd="url(#arrow)" />
                    <line x1="360" y1="124" x2="360" y2="164" markerEnd="url(#arrow)" />
                    <line x1="360" y1="144" x2="640" y2="144" />
                    <line x1="640" y1="144" x2="640" y2="164" markerEnd="url(#arrow)" />

                    {/* Adapter boxes (2-line, h=72) */}
                    <rect x="20" y="164" width="120" height="72" rx="2" />
                    <rect x="300" y="164" width="120" height="72" rx="2" />
                    <rect x="580" y="164" width="120" height="72" rx="2" />

                    {/* Arrows down to destinations */}
                    <line x1="80" y1="236" x2="80" y2="280" markerEnd="url(#arrow)" />
                    <line x1="360" y1="236" x2="360" y2="280" markerEnd="url(#arrow)" />
                    <line x1="640" y1="236" x2="640" y2="280" markerEnd="url(#arrow)" />

                    {/* Destination boxes (2-line, h=72). The protocol box is
                        widened to w=200 (centered at x=360) so "PC treasury +
                        $LAYER burn" fits; the bid and referral boxes stay at
                        w=120. Each leg has a single fixed destination from
                        block one — no phased second tier. */}
                    <rect x="20" y="280" width="120" height="72" rx="2" />
                    <rect x="260" y="280" width="200" height="72" rx="2" />
                    <rect x="580" y="280" width="120" height="72" rx="2" />
                </g>

                <g fontFamily="var(--mono)" fill="currentColor" textAnchor="middle">
                    {/* Source — y0=20, baselines y0+28=48, y0+50=70 */}
                    <text x="360" y="48" fontSize="13">
                        Pool + Hook
                    </text>
                    <text x="360" y="70" fontSize="11" opacity="0.7">
                        {fmtPct(FEES.baselineSkimPct)} per swap
                    </text>

                    {/* Percentages. Bid + protocol sit above the trunk (y=124);
                        the referral label sits above its own branch line (y=144),
                        which leaves the protocol leg because the slice is carved
                        from the protocol share. */}
                    <text x="80" y="116" fontSize="11">{fmtPct(FEES.bidLegPct)}</text>
                    <text x="360" y="116" fontSize="11">{fmtPct(FEES.protocolLegPct)}</text>
                    <text x="500" y="138" fontSize="11">up to {fmtPct(FEES.referralCapPct)}</text>

                    {/* Adapter labels — y0=164, baselines y0+28=192, y0+50=214 */}
                    <text x="80" y="192" fontSize="12">LiveBid</text>
                    <text x="80" y="214" fontSize="11" opacity="0.7">Adapter</text>

                    <text x="360" y="192" fontSize="12">ProtocolFee</text>
                    <text x="360" y="214" fontSize="11" opacity="0.7">PhaseAdapter</text>

                    <text x="640" y="192" fontSize="12">Referral</text>
                    <text x="640" y="214" fontSize="11" opacity="0.7">Payout</text>

                    {/* Destinations — y0=280, baselines y0+28=308, y0+50=330.
                        One fixed destination per leg, from block one. */}
                    <text x="80" y="308" fontSize="12">Patron</text>
                    <text x="80" y="330" fontSize="11" opacity="0.7">live bid</text>

                    <text x="360" y="308" fontSize="12">PCController</text>
                    <text x="360" y="330" fontSize="11" opacity="0.7">PC treasury + $LAYER burn</text>

                    <text x="640" y="308" fontSize="12">Referrer</text>
                    <text x="640" y="330" fontSize="11" opacity="0.7">attributed swaps</text>
                </g>
            </svg>
            <figcaption className="protocol-diagram-caption">
                Fee routing: the {fmtPct(FEES.baselineSkimPct)} baseline skim
                splits inside the hook on every swap, each leg to a fixed
                destination from block one: the bid leg to Patron, the protocol
                leg to PCController, and a referral slice carved from the
                protocol leg for the named referrer on attributed swaps. The
                separate {fmtPct(FEES.lpFeePct)} V4 LP fee (not shown) is paid
                to LP holders; at launch the LP locker routes its share through
                FeeAutoSwapper to the live bid too.
            </figcaption>
        </figure>
    );
}

/* ─────────────────────────────────────────────────────────────────
   Auction lifecycle diagram. Timeline from acceptBid to settle, with
   the branch between cleared and silenced and the proceeds routing
   on each branch.
   ───────────────────────────────────────────────────────────────── */
function AuctionLifecycleDiagram() {
    /* Box-padding standard across all diagrams (also applied in
       FeeRoutingDiagram and ArchitectureDiagram):
         - 2-line box: h=72, text baselines at y0+28 and y0+50
         - 3-line box: h=92, text baselines at y0+28, y0+50, y0+72
       Top + bottom padding lands around 18-20px so text never touches
       the box edges. */
    return (
        <figure className="protocol-diagram" aria-label={`Diagram: ${AUCTION.durationHours}-hour auction timeline with cleared and silenced outcomes`}>
            <svg
                role="img"
                viewBox="0 0 880 540"
                preserveAspectRatio="xMidYMid meet"
                xmlns="http://www.w3.org/2000/svg"
            >
                <defs>
                    <marker
                        id="arrow-auction"
                        viewBox="0 0 10 10"
                        refX="9"
                        refY="5"
                        markerWidth="6"
                        markerHeight="6"
                        orient="auto-start-reverse"
                    >
                        <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                    </marker>
                </defs>

                <g
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1"
                    className="protocol-diagram-strokes"
                >
                    {/* Timeline */}
                    <line x1="80" y1="80" x2="720" y2="80" />
                    <circle cx="80" cy="80" r="5" fill="currentColor" />
                    <circle cx="720" cy="80" r="5" fill="currentColor" />

                    {/* acceptBid → auction-module drop (2-line box, h=72) */}
                    <line x1="80" y1="86" x2="80" y2="138" markerEnd="url(#arrow-auction)" />
                    <rect x="20" y="138" width="120" height="72" rx="2" />

                    {/* Window note → straight down to fork (2-line box, h=72) */}
                    <line x1="720" y1="86" x2="720" y2="138" markerEnd="url(#arrow-auction)" />
                    <rect x="660" y="138" width="120" height="72" rx="2" />

                    {/* The two branches from auction end */}
                    <line x1="720" y1="210" x2="720" y2="246" />
                    <line x1="280" y1="246" x2="720" y2="246" />
                    <line x1="280" y1="246" x2="280" y2="280" markerEnd="url(#arrow-auction)" />
                    <line x1="720" y1="246" x2="720" y2="280" markerEnd="url(#arrow-auction)" />

                    {/* Outcome boxes (3-line box, h=92) — centers at x=280 and x=720 */}
                    <rect x="160" y="280" width="240" height="92" rx="2" />
                    <rect x="600" y="280" width="240" height="92" rx="2" />

                    {/* Proceeds boxes — centered under their outcomes, h=92 for symmetry */}
                    <line x1="280" y1="372" x2="280" y2="406" markerEnd="url(#arrow-auction)" />
                    <rect x="160" y="406" width="240" height="92" rx="2" />

                    <line x1="720" y1="372" x2="720" y2="406" markerEnd="url(#arrow-auction)" />
                    <rect x="600" y="406" width="240" height="92" rx="2" />
                </g>

                <g fontFamily="var(--mono)" fill="currentColor" textAnchor="middle">
                    {/* Timeline endpoint labels */}
                    <text x="80" y="60" fontSize="11">T = 0</text>
                    <text x="80" y="48" fontSize="10" opacity="0.7">acceptBid</text>

                    <text x="720" y="60" fontSize="11">T = {AUCTION.durationHours}h</text>
                    <text x="720" y="48" fontSize="10" opacity="0.7">deadline</text>

                    {/* Drop-in box (the auction module takes custody):
                        y0=138, baselines y0+28=166, y0+50=188 */}
                    <text x="80" y="166" fontSize="12">Punk → auction</text>
                    <text x="80" y="188" fontSize="11" opacity="0.7">cost paid to owner</text>

                    {/* End-of-window node — y0=138, baselines y0+28=166, y0+50=188 */}
                    <text x="720" y="166" fontSize="12">Auction ends</text>
                    <text x="720" y="188" fontSize="11" opacity="0.7">cleared or silenced</text>

                    {/* Mid-timeline note */}
                    <text x="400" y="72" fontSize="11" opacity="0.65">
                        bid at or above the reserve clears ({AUCTION.snipeExtensionTriggerMin}min
                        anti-snipe extends +{AUCTION.snipeExtensionGainHours}h)
                    </text>

                    {/* Cleared box (3-line, y0=280, baselines y0+28=308, y0+50=330, y0+72=352) */}
                    <text x="280" y="308" fontSize="12">Cleared</text>
                    <text x="280" y="330" fontSize="11" opacity="0.7">
                        bid at or above reserve
                    </text>
                    <text x="280" y="352" fontSize="11" opacity="0.7">
                        Punk → buyer
                    </text>

                    {/* Silenced box (3-line, same y) */}
                    <text x="720" y="308" fontSize="12">Silenced</text>
                    <text x="720" y="330" fontSize="11" opacity="0.7">
                        no bid by deadline
                    </text>
                    <text x="720" y="352" fontSize="11" opacity="0.7">
                        Punk → PunkVault
                    </text>

                    {/* Cleared proceeds (3-line, y0=406, baselines 434, 456, 478) */}
                    <text x="280" y="434" fontSize="11">
                        {fmtPct(CLEARED_SPLIT.liveBidPct)} cost → LiveBidAdapter
                    </text>
                    <text x="280" y="456" fontSize="11">
                        {fmtPct(CLEARED_SPLIT.buybackBurnPct)} cost → BuybackBurner
                    </text>
                    <text x="280" y="478" fontSize="11" opacity="0.7">
                        {fmtPct(CLEARED_SPLIT.vaultBurnPct)} cost + premium → VaultBurnPool
                    </text>

                    {/* Silenced proceeds (3-line, same y) */}
                    <text x="720" y="434" fontSize="11">
                        chosen trait → permanent
                    </text>
                    <text x="720" y="456" fontSize="11" opacity="0.7">
                        Proof mints to seller
                    </text>
                    <text x="720" y="478" fontSize="11" opacity="0.7">
                        VaultBurnPool → BuybackBurner
                    </text>
                </g>
            </svg>
            <figcaption className="protocol-diagram-caption">
                Return auction lifecycle: {AUCTION.durationHours} hours from
                acceptance to settle. A bid at or above the reserve clears the
                auction; no bid sends the Punk to the vault and the chosen trait
                becomes permanent. Any premium the cleared bid carries above cost
                queues in the vault burn pool and flushes to BuybackBurner on the
                next vaulted settle.
            </figcaption>
        </figure>
    );
}

const styles = `
.protocol-hero {
    padding-top: clamp(60px, 9vh, 100px);
    padding-bottom: clamp(40px, 6vh, 70px);
    border-top: none;
}
.protocol-h1 {
    font-family: var(--serif);
    font-weight: 300;
    font-size: clamp(34px, 5vw, 60px);
    line-height: 1.04;
    letter-spacing: -0.035em;
    margin: 12px 0 24px;
    max-width: 32ch;
}
.protocol-lede {
    font-family: var(--sans);
    font-size: 18px;
    line-height: 1.62;
    color: var(--muted);
    max-width: 60ch;
}
.protocol-grid {
    display: grid;
    grid-template-columns: minmax(160px, 200px) minmax(0, 1fr);
    gap: clamp(28px, 5vw, 64px);
    align-items: start;
}
.protocol-sec-label {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    padding-top: 6px;
}
.protocol-sec-body {
    /* Body fills the grid column. Prose elements set their own
       max-width below so paragraphs stay readable while diagrams
       and contract tables can stretch wider. */
    font-family: var(--sans);
    font-size: 16px;
    line-height: 1.7;
    color: var(--ink);
    display: flex;
    flex-direction: column;
    gap: 14px;
}
.protocol-sec-body > p,
.protocol-sec-body > ul,
.protocol-sec-body > ol {
    max-width: 64ch;
}
.protocol-sec-body strong { font-weight: 600; }
.protocol-sec-body em { font-style: italic; color: var(--accent); }
.protocol-sec-body code {
    font-family: var(--mono);
    font-size: 0.92em;
    background: var(--panel, rgba(0, 0, 0, 0.04));
    padding: 1px 5px;
}
.protocol-h3 {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink);
    margin: 18px 0 4px;
    padding-top: 6px;
}
.protocol-bullets {
    margin: 0;
    padding-left: 22px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.protocol-contracts {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    border-top: 1px solid var(--line);
}
.protocol-contract {
    display: grid;
    /* Widened name column so the longest contract names
       (PermanentCollectionMosaicRenderer, PermanentCollectionProofRenderer)
       fit without overflowing into the description.
       minmax(0, ...) is critical here — grid items default to
       min-width: auto which uses min-content (the longest unbreakable
       word) as the floor. Without explicitly allowing the column to
       shrink, an undivided long contract name like
       PermanentCollectionMosaicRenderer pushes the column past its max
       and overflows. */
    grid-template-columns: minmax(0, 320px) minmax(0, 1fr);
    gap: 18px;
    padding: 12px 0;
    border-bottom: 1px solid var(--line);
}
.protocol-contract-name {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--ink);
    line-height: 1.4;
    /* min-width: 0 lets the grid item shrink below its content size,
       and word-break: break-word permits wrapping the long camel-case
       name at any character when it overflows. */
    min-width: 0;
    word-break: break-word;
    overflow-wrap: anywhere;
}
.protocol-contract-note {
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.55;
    color: var(--muted);
}
.protocol-contract-addr {
    grid-column: 1 / -1;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--accent);
}
.protocol-diagram {
    margin: 8px 0 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    color: var(--ink);
    /* Diagrams break out of the 64ch prose constraint so the SVG
       content has room to render without clipping. Capped so the
       diagram still feels rooted in the body column, not stretched
       to the page edge. */
    width: 100%;
    max-width: 920px;
}
@media (min-width: 760px) {
    /* On desktop, extend the diagram leftward into the section-label
       column so it gets the full grid-row width. The grid has a label
       column of minmax(160px, 200px) and a gap of clamp(28px, 5vw, 64px).
       Shifting left by (200px + the gap) at desktop lines the diagram up
       with the left edge of the label column. */
    .protocol-diagram {
        margin-left: calc(-1 * (200px + clamp(28px, 5vw, 64px)));
        width: calc(100% + 200px + clamp(28px, 5vw, 64px));
        max-width: 1120px;
    }
}
.protocol-diagram svg {
    width: 100%;
    height: auto;
    display: block;
}
.protocol-diagram-caption {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.04em;
    color: var(--muted);
    line-height: 1.55;
}
@media (max-width: 760px) {
    .protocol-grid {
        grid-template-columns: 1fr;
        gap: 14px;
    }
    .protocol-sec-label {
        padding-top: 0;
    }
    .protocol-contract {
        grid-template-columns: 1fr;
        gap: 4px;
    }
    .protocol-diagram svg {
        font-size: 10px;
    }
}
`;
