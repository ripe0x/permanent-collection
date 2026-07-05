import type {Metadata} from 'next';
import type {ReactNode} from 'react';
import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {getTokenTicker} from '@/lib/config';
import {buildMeta} from '@/lib/meta';
import {
    ADAPTER,
    ADMIN,
    ANTI_SNIPER,
    AUCTION,
    CLEARED_SPLIT,
    COLLECTION,
    FEES,
    SOLE_CARRIER,
    TAX,
    TITLE,
    fmtPct,
} from '@/lib/protocol-params';

const TICKER = getTokenTicker();

export const metadata: Metadata = buildMeta({
    title: 'FAQ — Permanent Collection',
    description:
        'How Permanent Collection works. The live bid, return auctions, the vault, the artcoin, fees, permanence, and the long arc.',
    path: '/faq',
});

interface QA {
    q: string;
    a: ReactNode;
    /** Optional stable anchor so other pages can deep-link to this answer
     *  (e.g. /faq#which-trait-becomes-permanent). Rendered as the item's id. */
    id?: string;
}

interface Section {
    title: string;
    items: QA[];
}

const SECTIONS: Section[] = [
    {
        title: 'The work',
        items: [
            {
                q: 'What is Permanent Collection?',
                a: (
                    <>
                        Permanent Collection is an onchain protocol and a live artwork. It assembles
                        a permanent collection of CryptoPunks by trait. Trading in the official pool
                        funds a single public ETH bid. A Punk carrying an uncollected trait can
                        accept the bid. The Punk then enters a {AUCTION.durationHours}-hour return
                        auction. If the market returns the Punk to circulation, the trait stays
                        open. If not, the Punk enters the vault and one chosen trait becomes
                        permanent. The work completes when all {COLLECTION.totalTraits} distinct
                        traits are represented by vaulted Punks.
                    </>
                ),
            },
            {
                q: 'Why CryptoPunks?',
                a: (
                    <>
                        Punks are one of the clearest examples of onchain culture becoming art
                        history. They&apos;re images, but they&apos;re also a network of owners,
                        traits, prices, provenance, wallets, bids, and belief. The collection has
                        always extended beyond the image. Permanent Collection treats that network
                        as part of the material.
                    </>
                ),
            },
            {
                q: 'Why collect by trait, instead of by Punk?',
                a: (
                    <>
                        Traits are how Punks became legible to the market and to culture. Alien,
                        Ape, Hoodie, Beanie, Small Shades, every other one. The sealed dataset
                        contains {COLLECTION.totalTraits} distinct traits. By recording one trait
                        per vaulted Punk, the protocol writes a permanent record one decision at a
                        time. A common looking Punk can become historically important by completing
                        a small trait. A famous Punk might be eligible only because of a single
                        accessory. The system can&apos;t predict which Punks end up permanent.
                    </>
                ),
            },
            {
                q: 'Is this affiliated with the original CryptoPunks team or Yuga Labs?',
                a: (
                    <>
                        No. Permanent Collection is independent. It reads the canonical onchain
                        CryptoPunks dataset and interacts with the original 2017 Punks market the
                        same way any other participant does.
                    </>
                ),
            },
        ],
    },
    {
        title: 'The live bid',
        items: [
            {
                q: 'What is the live bid?',
                a: (
                    <>
                        One global ETH offer. It&apos;s standing open to any eligible Punk owner.
                        Anyone can read the current amount. Any eligible Punk owner can accept it.
                    </>
                ),
            },
            {
                q: 'How is the live bid funded?',
                a: (
                    <>
                        Mostly by trading. Every {TICKER} swap pays a {fmtPct(FEES.baselineSkimPct)}{' '}
                        baseline skim. The skim splits inside the same swap into a bid leg of{' '}
                        {fmtPct(FEES.bidLegPct)} of volume and a protocol leg of{' '}
                        {fmtPct(FEES.protocolLegPct)}. The bid leg streams into the live bid through
                        an adapter that runs in fast mode below an activation threshold (filling the
                        bid uncapped) and switches to a rate cap above it. At launch the conversion locker holds 100% of the
                        official pool&apos;s LP positions and routes its share of the{' '}
                        {fmtPct(FEES.lpFeePct)} V4 LP fee to the same adapter, so the LP fee feeds
                        the bid too until public LPs add depth. Cleared return auctions also send{' '}
                        {fmtPct(CLEARED_SPLIT.liveBidPct)} of the original bid back into the live
                        bid.
                    </>
                ),
            },
            {
                q: 'Why does the live bid fill fast at first and slow down as it gets higher?',
                a: (
                    <>
                        By design. While the live bid is small (below the activation threshold) the
                        adapter forwards buffered fees into the bid uncapped, so it warms up quickly
                        at launch. Once the bid reaches realistic Punk price territory the adapter
                        switches to a rate cap: it adds at most {ADAPTER.maxSweepEth} ETH per short
                        cooldown, so a sudden burst of volume drips in instead of lurching the
                        standing offer past floor prices in a single block.
                    </>
                ),
            },
            {
                q: 'What is the activation threshold and how is it set?',
                a: (
                    <>
                        It&apos;s the live bid level that separates the two modes: below it the bid
                        fills uncapped, at or above it the rate cap applies. It isn&apos;t hand
                        managed. After each accepted Punk it resets to {ADAPTER.bandPct}% of that
                        clearing price (the latest revealed floor, minus a {100 - ADAPTER.bandPct}%
                        band), so the fast fill ceiling tracks the real market and the throttle
                        engages before the bid reaches floor. It opens at a{' '}
                        {ADAPTER.activationThresholdSeedEth} ETH launch seed and is capped at{' '}
                        {ADAPTER.thresholdCapEth} ETH.
                    </>
                ),
            },
            {
                q: 'Why is there only one bid?',
                a: (
                    <>
                        The protocol is one collector with one open offer. A single bid keeps the
                        work legible. Anyone can read the current price the protocol is willing to
                        pay for any eligible Punk. Per Punk bids would turn the protocol into a
                        strategy game. One bid keeps it an artwork.
                    </>
                ),
            },
            {
                q: 'Can the live bid be canceled or withdrawn?',
                a: (
                    <>
                        No. The contract holding the live bid can pay out only by acquiring an
                        eligible Punk. There&apos;s no admin withdrawal, no governance withdrawal,
                        no upgrade path that can reach the balance.
                    </>
                ),
            },
            {
                q: 'Can I add to the live bid without trading?',
                a: (
                    <>
                        Yes. Anyone can send ETH directly to the live bid adapter. There&apos;s also
                        an attributed contribution function for integrations like launchpads,
                        wallets, or apps that want to route a portion of their own activity into the
                        bid. A small share of an attributed contribution can go to a tagged
                        referrer. The remainder buffers into the bid.
                    </>
                ),
            },
        ],
    },
    {
        title: 'Accepting and the return auction',
        items: [
            {
                q: 'Who can accept the live bid?',
                a: (
                    <>
                        The current owner of an eligible Punk. The owner lists the Punk to the
                        protocol at any positive price up to the current live bid. Once the listing
                        is in place, anyone can finalize the sale onchain. The seller is paid the
                        listed amount through the canonical CryptoPunks market.
                    </>
                ),
            },
            {
                q: 'What makes a Punk eligible?',
                a: (
                    <>
                        A Punk is eligible if it carries at least one trait that&apos;s still
                        uncollected and not currently in an active return auction. The protocol
                        records the rarest uncollected trait the Punk carries. Ties go to the lowest
                        trait index. The choice is mechanical, not curated, and the same for every
                        eligible Punk.
                    </>
                ),
            },
            {
                q: 'How is the trait that becomes permanent chosen?',
                id: 'which-trait-becomes-permanent',
                a: (
                    <>
                        You don&apos;t choose it, and neither does the finder or the admin. The
                        protocol derives it: the rarest uncollected trait the Punk carries that
                        isn&apos;t already in an active return auction. Ties go to the lowest trait
                        index. The rule runs off the sealed dataset, so anyone reading the contract
                        can compute the same trait for the same Punk, and the bid page shows you
                        exactly which trait before you sign. Making the choice mechanical keeps it
                        from becoming a strategy lever and protects the rarer traits from being
                        skipped in favor of common ones. The trait only becomes permanent if the
                        Punk isn&apos;t returned during its {AUCTION.durationHours}-hour return
                        auction.
                    </>
                ),
            },
            {
                q: "What if my Punk's traits are all already permanent?",
                a: (
                    <>
                        Then it&apos;s no longer eligible. The protocol only acquires a Punk that
                        carries at least one uncollected, non-pending trait. As the collection fills
                        in, fewer Punks remain eligible. Some Punks become permanently ineligible
                        because every trait they carry is already represented by a vaulted Punk.
                    </>
                ),
            },
            {
                q: 'What happens after a Punk owner accepts?',
                a: (
                    <>
                        The Punk moves into a {AUCTION.durationHours}-hour return auction. The owner
                        is paid through the canonical Punks market. The live bid balance drops by
                        the listed amount. The protocol&apos;s records grow by one acquisition row
                        with the chosen trait recorded.
                    </>
                ),
            },
            {
                q: 'What is a return auction?',
                a: (
                    <>
                        A {AUCTION.durationHours}-hour window in which the market can return the
                        Punk to circulation. Anyone can place a bid. A bid above the reserve at the
                        deadline returns the Punk to the winning bidder, and the trait stays open.
                        If no bid clears the reserve by the deadline, the Punk enters the vault and
                        the chosen trait becomes permanent.
                    </>
                ),
            },
            {
                q: 'What is the reserve in a return auction?',
                a: (
                    <>
                        The reserve is the protocol&apos;s acquisition cost plus a small premium.
                        The first auction for a given trait reserves at cost plus 1%. Each prior
                        contested auction for the same trait adds another 1%. The reserve is locked
                        in when the auction starts.
                    </>
                ),
            },
            {
                q: 'When I am outbid, do I get my bid back?',
                a: (
                    <>
                        Yes. When someone places a higher bid, the previous high bidder is refunded
                        automatically. If that automatic refund fails to send, the funds aren&apos;t
                        lost. You can claim them from the return auction contract.
                    </>
                ),
            },
            {
                q: 'Why did the auction deadline move after a late bid?',
                a: (
                    <>
                        Bids placed in the final {AUCTION.snipeExtensionTriggerMin} minutes extend
                        the deadline by {AUCTION.snipeExtensionGainHours} hour. This keeps a last
                        second bid from ending the auction before anyone can respond. The extension
                        is uncapped, so an auction stays open as long as bidding keeps coming in.
                    </>
                ),
            },
            {
                q: 'Can the same Punk go through more than one return auction?',
                a: (
                    <>
                        Yes. If a Punk is returned to circulation by a winning bid, the owner can
                        accept the live bid again later if the Punk is still eligible. Each new
                        acceptance starts a fresh {AUCTION.durationHours}-hour window with a fresh
                        reserve, and the protocol records a new acquisition row. Once a Punk enters
                        the vault, that path is closed.
                    </>
                ),
            },
        ],
    },
    {
        title: 'The vault',
        items: [
            {
                q: 'What does it mean for a Punk to be vaulted?',
                a: (
                    <>
                        A vaulted Punk has entered a custody contract with no withdrawal path. The
                        recorded trait becomes permanent at the same moment.
                    </>
                ),
            },
            {
                q: 'Can a vaulted Punk ever leave?',
                a: (
                    <>
                        No. The vault contract holds Punks through a structure that can&apos;t move
                        them. This is asserted at the bytecode level. No transfer, withdraw, rescue,
                        or sweep selector exists in the deployed contract. The launch tests fail if
                        any of those ever appear.
                    </>
                ),
            },
            {
                q: 'Why does only one trait become permanent per vaulted Punk?',
                a: (
                    <>
                        A Punk usually carries several traits. The protocol records the rarest
                        uncollected one at acquisition, and only that one becomes permanent on
                        vaulting. The Punk&apos;s other uncollected traits stay open for the future.
                        This makes vaulting feel deliberate, and keeps the system from racing
                        through the easy traits first.
                    </>
                ),
            },
            {
                q: 'What are the Proofs, and who gets them?',
                a: (
                    <>
                        When a Punk is vaulted and a trait becomes permanent for the first time, an
                        ERC721 Proof is minted. There can be up to {COLLECTION.proofTokenCount}{' '}
                        Proofs, one per trait. The Proof is minted to the recorded seller of the
                        Punk. If the Punk&apos;s owner accepted the live bid directly, the Proof
                        goes to them. If the Punk was acquired through an allowlisted public listing
                        finalized by a third party finder, the Proof goes to the listing seller, not
                        the finder. The finder is paid a small fee, the seller is paid the listing
                        price, and the seller receives the Proof on settle. Proofs don&apos;t grant
                        withdrawal rights over the vault and don&apos;t carry a claim on the Punks
                        inside.
                    </>
                ),
            },
            {
                q: 'Is there a Punk the protocol can never waste?',
                a: (
                    <>
                        Yes. The sealed Punks dataset has exactly one rarity-1 trait, &ldquo;
                        {SOLE_CARRIER.traitName}&rdquo;, carried by exactly one Punk: #
                        {SOLE_CARRIER.punkId}. If that Punk were vaulted against any common trait it
                        also carries, the rare trait would be stranded forever and the collection
                        could never complete. The records core enforces this. While the rare trait
                        is still uncollected, an acceptance of Punk #{SOLE_CARRIER.punkId} can only
                        target the rare trait. The unique carrier of the unique rarest trait can
                        never be wasted on a common one.
                    </>
                ),
            },
            {
                q: 'What is the Vault Title?',
                a: (
                    <>
                        The Vault Title is a single ERC721 token, separate from the Proofs. It names
                        a steward of the vault. It&apos;s sold through its own auction once at
                        least {TITLE.kickoffThreshold} traits are permanent, and the Title can be
                        contested again during the protocol&apos;s collecting phase. The Title
                        doesn&apos;t grant withdrawal rights, doesn&apos;t control the vault, and
                        doesn&apos;t carry governance over the protocol. It&apos;s a title record
                        and a stewardship object.
                    </>
                ),
            },
        ],
    },
    {
        title: 'The onchain artwork',
        items: [
            {
                q: 'Where does the trait artwork come from?',
                a: (
                    <>
                        The canonical onchain Punks dataset. A sealed 2017 era contract called
                        PunksData stores every trait name and every Punk&apos;s pixel data. The
                        renderer reads from PunksData directly. The dataset hash is pinned into the
                        records core at deploy, and the constructor reverts if the live contract
                        doesn&apos;t match. The protocol is bound to the exact dataset it launched
                        against. No substitution is possible.
                    </>
                ),
            },
            {
                q: 'Is the artwork stored anywhere offchain?',
                a: (
                    <>
                        No. The token&apos;s tokenURI returns a complete data URL built inside the
                        contract. The trait grid, the trait icons, the Punk pixels, the JSON
                        metadata, all of it is generated from sealed onchain sources at read time.
                        There&apos;s no IPFS dependency, no Arweave dependency, no hosted image
                        server. If this site disappears tomorrow, the token still renders.
                    </>
                ),
            },
            {
                q: 'How does the image stay current?',
                a: (
                    <>
                        The renderer reads the live state of the collection every time tokenURI is
                        called. Each of the {COLLECTION.totalTraits} cells shows one of three
                        states. An uncollected cell shows the isolated trait icon. A pending cell
                        shows the trait icon for a Punk in active return auction. A permanent cell
                        shows the vaulted Punk that made the trait permanent. When a return auction
                        settles, the next read of tokenURI reflects the new state. Wallets and
                        marketplaces show the change as soon as they refresh.
                    </>
                ),
            },
            {
                q: `What's the difference between the artwork on ${TICKER}, the Proofs, and the Vault Title?`,
                a: (
                    <>
                        Three views of the same collection. {TICKER}&apos;s image is the whole grid,
                        all {COLLECTION.totalTraits} traits at once, updated live. A Proof is a
                        single cell: the specific Punk that made one specific trait permanent, with
                        the trait icon composited cleanly on top of the vaulted Punk drawn at low
                        opacity behind it. The Vault Title&apos;s image is the singular title
                        record for the vault. All three render fully onchain from the same dataset.
                    </>
                ),
            },
        ],
    },
    {
        title: 'The artcoin',
        items: [
            {
                q: `What is ${TICKER}?`,
                a: (
                    <>
                        {TICKER} is the artcoin for Permanent Collection. It&apos;s an ERC20 on
                        Ethereum. The official pool is a Uniswap V4 pool of {TICKER} against ETH.
                        Trading in that pool feeds the live bid. The token&apos;s tokenURI renders
                        the live state of the collection, so every wallet showing {TICKER} shows the
                        same evolving artwork.
                    </>
                ),
            },
            {
                q: `Does holding ${TICKER} give me a claim on the vault or the Punks?`,
                a: (
                    <>
                        No. {TICKER} doesn&apos;t redeem for vaulted Punks, doesn&apos;t control the
                        vault, and carries no governance over the protocol. There&apos;s no DAO, no
                        vote, no parameter change open to holders. {TICKER} is the liquid artwork
                        and the market that funds the live bid.
                    </>
                ),
            },
            {
                q: 'Why an ERC20 instead of an NFT?',
                a: (
                    <>
                        An NFT would make participation singular. An ERC20 puts it on the open
                        market: anyone can buy or sell {TICKER} at any size. Every buy and sell pays
                        the fee that grows the live bid, so ordinary trading is what funds Punk
                        acquisition. Holders get no vote over the vault, the Punks, or the fees.
                    </>
                ),
            },
            {
                q: 'What does the renderer show?',
                a: (
                    <>
                        A grid of all {COLLECTION.totalTraits} traits. Open slots show isolated
                        traits. Slots in active return auction are marked as pending. Permanent
                        slots show the vaulted Punk that made the trait permanent. The image is
                        drawn from chain state, so it updates as the collection advances.
                    </>
                ),
            },
        ],
    },
    {
        title: 'Fees and trading',
        items: [
            {
                q: 'What is the official pool, and why does it matter where I trade?',
                a: (
                    <>
                        The official pool is one specific Uniswap V4 pool of {TICKER} against ETH.
                        Only swaps on this pool feed the protocol. Side pools, OTC trades, or
                        aggregator routes that bypass the official pool don&apos;t feed the live
                        bid. The protocol&apos;s funding depends on trading happening in the right
                        venue.
                    </>
                ),
            },
            {
                q: 'Where do the swap fees go?',
                a: (
                    <>
                        Every swap pays a {fmtPct(FEES.totalSwapFeePct)} total fee.{' '}
                        {fmtPct(FEES.lpFeePct)} is the standard V4 LP fee paid to liquidity
                        providers. The remaining {fmtPct(FEES.baselineSkimPct)} is the protocol
                        skim. It splits inside the same swap into a bid leg of{' '}
                        {fmtPct(FEES.bidLegPct)} of volume and a protocol leg of{' '}
                        {fmtPct(FEES.protocolLegPct)}. The protocol leg covers operations and a
                        small {TICKER} buy and burn. At launch the LP fee also feeds the live bid,
                        because the conversion locker holds 100% of LP positions and routes its
                        share to the live bid adapter.
                    </>
                ),
            },
            {
                q: 'What happens to value when a return auction clears?',
                a: (
                    <>
                        The protocol&apos;s acquisition cost splits three ways:{' '}
                        {fmtPct(CLEARED_SPLIT.liveBidPct)} refills the live bid,{' '}
                        {fmtPct(CLEARED_SPLIT.buybackBurnPct)} buys and burns {TICKER}, and{' '}
                        {fmtPct(CLEARED_SPLIT.vaultBurnPct)} goes to a separate {TICKER} burn pool.
                        The premium above cost, paid by the rescuing bidder, mostly joins the burn
                        pool. {fmtPct(CLEARED_SPLIT.referrerPremiumPct)} of the premium is reserved
                        for the winning bidder&apos;s referrer if one was tagged. So the cost moves
                        value through the system, and the premium drives a burn.
                    </>
                ),
            },
            {
                q: 'Is there an anti-sniper period at launch?',
                a: (
                    <>
                        Yes. For roughly the first {Math.round(ANTI_SNIPER.durationMin)} minutes
                        after the pool opens, the swap skim is elevated. It decays linearly from{' '}
                        {fmtPct(ANTI_SNIPER.peakPct)} down to the {fmtPct(ANTI_SNIPER.baselinePct)}{' '}
                        baseline. Any extra skim collected during this window flows entirely into
                        the live bid, so early MEV activity ends up funding the protocol rather than
                        extracting from it.
                    </>
                ),
            },
            {
                q: `What's the transfer tax on ${TICKER} I see flagged in some block explorers?`,
                a: (
                    <>
                        A buy-side tax that fires only when {TICKER} leaves a non-official trading
                        venue. Buying {TICKER} from a side pool (a competing Uniswap V2 or V3 pair
                        on the same token, for example) costs an extra {fmtPct(TAX.launchPct)} on
                        top of the side pool&apos;s own fee. The taxed tokens are sent to the dead
                        address and burned. The protocol doesn&apos;t convert them to ETH and
                        doesn&apos;t list them. The intent is structural. The tax keeps trading
                        inside the venue that funds the live bid. The rate is tunable up to a hard{' '}
                        {fmtPct(TAX.capPct)} cap and can never exceed that ceiling.
                    </>
                ),
            },
            {
                q: `Does the tax fire when I sell ${TICKER} or move it around?`,
                a: (
                    <>
                        No. The tax fires only on buys from a non-official trading venue. Sells,
                        wallet sends, lending deposits, bridges, and CEX moves don&apos;t trigger
                        it. Buying from the official pool is exempt by design through a per-swap
                        budget the hook attests. The tax is a buy-side disincentive for one
                        specific behavior. It doesn&apos;t touch the rest of the token&apos;s
                        lifecycle.
                    </>
                ),
            },
        ],
    },
    {
        title: 'Permanence and the long arc',
        items: [
            {
                q: 'What stops the protocol from withdrawing the Punks later?',
                a: (
                    <>
                        The vault has no withdrawal function. This is enforced in code, not by
                        policy. Bytecode scans in the launch test suite check for any market write
                        selector and any admin exit selector on the vault. If any of them existed,
                        the launch tests would fail. There&apos;s no admin escape hatch, no
                        emergency exit, no upgrade path that can reach the Punks.
                    </>
                ),
            },
            {
                q: 'Who controls the contracts?',
                a: (
                    <>
                        A single admin role gates a small set of operational parameters at launch.
                        Most economic parameters lock {ADMIN.lockYears} year after launch. After
                        that, the admin role can still adjust a few narrow things, like adding new
                        sale venues to the allowlist or tuning the referral cap. It can&apos;t touch
                        the vault, the live bid balance, the auction reserve formula, or the
                        proceeds split. The admin role can also be burned at any time, which makes
                        every remaining tunable permanent.
                    </>
                ),
            },
            {
                q: `Is there a team allocation, presale, or airdrop for ${TICKER}?`,
                a: (
                    <>
                        No. 100% of the {TICKER} supply was deposited as liquidity in the official
                        pool at launch. A conversion locker holds those LP positions and routes its
                        share of fees to the live bid until public LPs add depth. There&apos;s no
                        team allocation, no presale, no airdrop, no vesting schedule. The only way
                        to acquire {TICKER} is to buy it from the pool, the same way anyone else
                        does.
                    </>
                ),
            },
            {
                q: 'Why is there no deadline?',
                a: (
                    <>
                        Permanence shouldn&apos;t depend on a clock. The protocol runs until every
                        trait is represented by a vaulted Punk, or until the remaining eligible
                        Punks stay outside the protocol indefinitely. The vault doesn&apos;t care
                        whether the work finishes in a year, ten years, or never. The record stays
                        valid either way.
                    </>
                ),
            },
            {
                q: 'What happens when all 111 traits become permanent?',
                a: (
                    <>
                        The collecting work is done. The vault holds the Punks that made each trait
                        permanent. The artcoin keeps trading. The renderer keeps showing the
                        completed collection. The contracts keep doing what they do, but
                        there&apos;s no more collecting left to do.
                    </>
                ),
            },
            {
                q: 'What if some traits never become permanent?',
                a: (
                    <>
                        That&apos;s a real possible outcome. Some traits are carried by very few
                        Punks. If those owners never accept the live bid, those traits stay open.
                        The collection might be 100, 105, 110 of {COLLECTION.totalTraits} forever.
                        The chain still holds the full record of what trading funded, which Punks
                        owners accepted, and which ones the market returned, and the grid keeps
                        rendering that record whether or not the count reaches{' '}
                        {COLLECTION.totalTraits}.
                    </>
                ),
            },
        ],
    },
];

export default function FaqPage() {
    return (
        <>
            <Header />
            <main id="top">
                <section className="faq-page">
                    <div className="wrap faq-wrap">
                        <div className="kicker">FAQ</div>
                        <h1 className="section-title">Questions.</h1>
                        <p className="faq-lede">
                            How Permanent Collection works, and the intent behind the mechanics.
                        </p>
                        <div className="faq-sections">
                            {SECTIONS.map((section) => (
                                <section className="faq-section" key={section.title}>
                                    <h2 className="faq-section-title">{section.title}</h2>
                                    <dl className="faq-list">
                                        {section.items.map((item) => (
                                            <div className="faq-item" id={item.id} key={item.q}>
                                                <dt className="faq-q">{item.q}</dt>
                                                <dd className="faq-a">{item.a}</dd>
                                            </div>
                                        ))}
                                    </dl>
                                </section>
                            ))}
                        </div>
                    </div>
                </section>
            </main>
            <Footer />
            <style>{styles}</style>
        </>
    );
}

const styles = `
.faq-page {
    padding-top: clamp(60px, 9vh, 100px);
    padding-bottom: clamp(80px, 12vh, 160px);
    border-top: none;
}
.faq-wrap {
    max-width: 760px;
    margin-left: 0;
}
.faq-lede {
    margin: 18px 0 0;
    font-family: var(--sans);
    font-size: clamp(16px, 1.7vw, 19px);
    line-height: 1.55;
    color: var(--muted);
    max-width: 56ch;
}
.faq-sections {
    margin-top: clamp(40px, 6vh, 64px);
    display: flex;
    flex-direction: column;
    gap: clamp(40px, 6vh, 64px);
}
.faq-section {
    padding: 0;
    border-top: none;
}
.faq-section-title {
    font-family: var(--serif);
    font-weight: 300;
    font-size: clamp(22px, 2.6vw, 30px);
    line-height: 1.2;
    letter-spacing: -0.02em;
    color: var(--ink);
    margin: 0 0 18px;
}
.faq-list {
    margin: 0;
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--line);
}
.faq-item {
    padding: 26px 0;
    border-bottom: 1px solid var(--line);
    /* Clear the 58px sticky header when deep-linked via #anchor. */
    scroll-margin-top: 76px;
}
.faq-q {
    font-family: var(--serif);
    font-weight: 300;
    font-size: clamp(19px, 2.2vw, 24px);
    line-height: 1.25;
    letter-spacing: -0.02em;
    color: var(--ink);
    margin: 0 0 12px;
}
.faq-a {
    margin: 0;
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.65;
    color: var(--muted);
    max-width: 64ch;
}
`;
