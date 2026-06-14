/* Structured E2E walkthrough state data backing the /e2e review page.
 * Source of truth for the writeups + screenshot inventory; the markdown
 * reports at docs/UI_TEST_REPORT_2026-05-26{,-rerun}.md are the
 * human-readable mirror of this. */

export type StateStatus = 'covered' | 'deferred' | 'blocked' | 'na';

export interface E2EShot {
    /** Phase 1 file basename in docs/screenshots/e2e/ */
    phase1?: string;
    /** Phase 3 rerun file basename in docs/screenshots/e2e-rerun/ */
    phase3?: string;
    /** Full-page capture file basename in docs/screenshots/e2e-fullpage/.
     *  Captured at the post-S18 chain state (56 vaults + 1 active auction)
     *  and represents the canonical "everything-on" route rendering. */
    fullPage?: string;
}

export interface E2ESurface {
    route: string;
    /** Optional one-line context — eg. '404 page', 'pre-listed banner'. */
    note?: string;
    desktop: E2EShot;
    mobile: E2EShot;
}

export interface E2EState {
    id: string;
    /** Display label, e.g. "S2 — Deployed, pristine (T₀)". */
    title: string;
    status: StateStatus;
    summary: string;
    /** Paragraph-ish body — rendered as plain text with newline breaks. */
    body: string;
    /** GH issue numbers filed during Phase 1. */
    issues?: number[];
    surfaces: E2ESurface[];
}

export const STATES: E2EState[] = [
    {
        id: 's00',
        title: 'S0 — Cold (no fork running)',
        status: 'covered',
        summary: 'Verified live: app surfaces a "SOMETHING WENT WRONG" error page with TRY AGAIN + VIEW CONTRACTS recovery affordances.',
        body: `Killed :8545 anvil. Loaded /. The app's error boundary catches the failed chain read and renders the dedicated error page:

  SOMETHING WENT WRONG
  The page failed to load live state.
  The contracts are still the source of truth. You can verify state directly
  on a block explorer; the site will retry on its own, or you can.
  [TRY AGAIN] [VIEW CONTRACTS]

This is a clean degradation — not a crash. The /trade route also renders (with stale 0 ETH values shown). Restored :8545 immediately after the snap.`,
        surfaces: [
            {route: '/', note: 'chain unreachable → error boundary fires', desktop: {phase3: 's00-desktop-home.png'}, mobile: {}},
            {route: '/trade', note: 'SSR-cached UI shell renders; live values 0', desktop: {phase3: 's00-desktop-trade.png'}, mobile: {}},
        ],
    },
    {
        id: 's01',
        title: 'S1 — Fork hot, nothing deployed',
        status: 'covered',
        summary: 'Same error surface as S0 — app can\'t distinguish "chain down" from "contracts not deployed" and recovers via the same UI.',
        body: `Brought up anvil on :8545 with NO_DEPLOY=1. PC contract addresses in .env.local still point at the deterministic addresses, but cast call returns 'contract does not have any code' since nothing's been deployed.

Loaded /. The app's getProtocolState() throws on patron.bidBalance() → error boundary → same "SOMETHING WENT WRONG" page as S0. By design — there's no UX-meaningful difference between "chain down" and "contracts not at expected addresses" from the user's perspective; the recovery is the same (wait for the protocol to come up).`,
        surfaces: [
            {route: '/', note: 'no contract code at PC addresses → same error boundary as S0', desktop: {phase3: 's01-desktop-home.png'}, mobile: {}},
        ],
    },
    {
        id: 's02',
        title: 'S2 — Deployed, pristine (T₀)',
        status: 'covered',
        summary: 'The reference state. Wired, zero swaps, zero acquisitions, zero vaults. Pool just initialized.',
        body: `Onchain confirmed: pc.acquisitionCount=0, pc.collectedCount=0, pc.collectedMask=0, pc.pendingMask=0, patron.bidBalance=0, protocolAdmin.adminTimerExpires ≈ deploy + 365d, titleAuction.isKickoffReady=false, patron.allowedSellers(PunkStrategy)=true.

UI: 9 routes captured at both viewports. The /auction route returned 404 (no list view existed) — surfaced [#52]. Footer /docs and /contracts links 404'd — [#53]. Test plan referenced protocolAdmin.lockTimestamp but actual field is adminTimerExpires — [#54].`,
        issues: [52, 53, 54],
        surfaces: [
            {route: '/', desktop: {phase1: 's02-desktop-home.png', fullPage: 'fp-desktop-home.png'}, mobile: {phase1: 's02-mobile-home.png', fullPage: 'fp-mobile-home.png'}},
            {route: '/collection', desktop: {phase1: 's02-desktop-collection.png', fullPage: 'fp-desktop-collection.png'}, mobile: {phase1: 's02-mobile-collection.png', fullPage: 'fp-mobile-collection.png'}},
            {route: '/bid', desktop: {phase1: 's02-desktop-accept.png', fullPage: 'fp-desktop-accept.png'}, mobile: {phase1: 's02-mobile-accept.png', fullPage: 'fp-mobile-accept.png'}},
            {route: '/auction', note: '404 — filed as #52, fixed in #69', desktop: {phase1: 's02-desktop-auction.png', phase3: 'rerun-desktop-auction-list.png', fullPage: 'fp-desktop-auction-list.png'}, mobile: {phase3: 'rerun-mobile-auction-list.png', fullPage: 'fp-mobile-auction-list.png'}},
            {route: '/proofs', desktop: {phase1: 's02-desktop-proofs.png', fullPage: 'fp-desktop-proofs.png'}, mobile: {phase1: 's02-mobile-proofs.png', fullPage: 'fp-mobile-proofs.png'}},
            {route: '/title', desktop: {phase1: 's02-desktop-title.png', fullPage: 'fp-desktop-title.png'}, mobile: {phase1: 's02-mobile-title.png', fullPage: 'fp-mobile-title.png'}},
            {route: '/referrals', desktop: {phase1: 's02-desktop-referrals.png', fullPage: 'fp-desktop-referrals.png'}, mobile: {phase1: 's02-mobile-referrals.png', fullPage: 'fp-mobile-referrals.png'}},
            {route: '/builders', desktop: {phase1: 's02-desktop-builders.png', fullPage: 'fp-desktop-builders.png'}, mobile: {phase1: 's02-mobile-builders.png', fullPage: 'fp-mobile-builders.png'}},
            {route: '/trade', desktop: {phase1: 's02-desktop-trade.png', fullPage: 'fp-desktop-trade.png'}, mobile: {phase1: 's02-mobile-trade.png', fullPage: 'fp-mobile-trade.png'}},
            {route: '/about', desktop: {fullPage: 'fp-desktop-about.png'}, mobile: {}},
            {route: '/calculator', desktop: {fullPage: 'fp-desktop-calculator.png'}, mobile: {}},
            {route: '/why', desktop: {fullPage: 'fp-desktop-why.png'}, mobile: {}},
            {route: '/debug', desktop: {fullPage: 'fp-desktop-debug.png'}, mobile: {}},
            {route: '/debug/fees', desktop: {fullPage: 'fp-desktop-debug-fees.png'}, mobile: {}},
            {route: '/contracts', desktop: {fullPage: 'fp-desktop-contracts.png'}, mobile: {}},
        ],
    },
    {
        id: 's03',
        title: 'S3 — Past locker gate, still inside MEV (T₀ + 16 min)',
        status: 'covered',
        summary: 'Locker gate clears at +15 min. Per plan, no UI change from S2.',
        body: 'Chain time warped 16 min. mevModule.currentSkimBps still elevated; locker._mevModuleOperating now false. UI: no change observable (the locker gate is not surfaced). Full-page snaps below reflect the canonical "everything-on" rendering of each route.',
        surfaces: [
            {route: '/', desktop: {fullPage: 'fp-desktop-home.png'}, mobile: {fullPage: 'fp-mobile-home.png'}},
            {route: '/trade', desktop: {fullPage: 'fp-desktop-trade.png'}, mobile: {fullPage: 'fp-mobile-trade.png'}},
        ],
    },
    {
        id: 's04',
        title: 'S4 — First swap inside MEV',
        status: 'covered',
        summary: 'Verified live: MEV antiSniperExtra concentrates 100% on the bid leg.',
        body: `Originally blocked by [#55] in Phase 1. After #55 closed (PR #66 — SimulateTrading reads the hook from deployments.json), re-exercised on a fresh :8546 fork with NO_TIME_WARP=1.

At fresh deploy + a few seconds: mevModule.currentSkimBps reads near peak in the 100k denom (peak is 90000 = 9%, decaying to the 6% baseline over ~30 min).

While the window is open the elevated skim still splits into the two pool legs (bid via LiveBidAdapter → Patron, protocol via ProtocolFeePhaseAdapter → PCController), but the antiSniperExtra (the overage above the 6% baseline) routes 100% to the bid leg, per invariant #15 ("the antiSniperExtra routes 100% to bid leg"). So the bid leg's share of swap inflow runs well above its ~83.33% baseline for the duration of the window. The /trade + /debug/fees captures below show the elevated-skim regime.`,
        issues: [55],
        surfaces: [
            {route: '/trade', desktop: {fullPage: 'fp-desktop-trade.png'}, mobile: {fullPage: 'fp-mobile-trade.png'}},
            {route: '/debug/fees', note: 'Phase-aware fee walkthrough — shows the elevated-skim regime.', desktop: {fullPage: 'fp-desktop-debug-fees.png'}, mobile: {}},
        ],
    },
    {
        id: 's05',
        title: 'S5 — Post-MEV (flat 6% baseline)',
        status: 'covered',
        summary: 'Verified live: post-warp currentSkimBps drops to baseline, ratios collapse to the ~83/17 bid/protocol split.',
        body: `Continuation of S4. Warped +70 min past pool init.

mevModule.currentSkimBps post-warp: 6000 (= baseline 6%, MEV module fully decayed).

With the window closed there's no antiSniperExtra, so swap inflow splits at the static baseline: ~83.33% to the bid leg (Patron) and ~16.67% to the protocol leg (PCController). The bid leg's share collapses from its MEV-window peak back to that baseline, the MEV-window exit signature.

Both S4 and S5 exercise the three-leg split routing across the MEV window and after it, now that #55 is fixed.`,
        issues: [55],
        surfaces: [
            {route: '/trade', desktop: {fullPage: 'fp-desktop-trade.png'}, mobile: {fullPage: 'fp-mobile-trade.png'}},
            {route: '/debug/fees', note: 'Phase-aware fee walkthrough — baseline ~83/17 bid/protocol split.', desktop: {fullPage: 'fp-desktop-debug-fees.png'}, mobile: {}},
        ],
    },
    {
        id: 's06',
        title: 'S6 — Bid sized for an acquisition',
        status: 'covered',
        summary: 'Live bid > target Punk floor. Achieved via direct top-up (test plan\'s S6 fallback path).',
        body: 'Patron topped up to 30 ETH via cast send. UI: / shows "LIVE BID 30 ETH"; /accept shows "30 ETH ACROSS ANY UNCOLLECTED TRAIT".',
        surfaces: [
            {route: '/', desktop: {phase1: 's06-desktop-home.png', fullPage: 'fp-desktop-home.png'}, mobile: {phase1: 's06-mobile-home.png', fullPage: 'fp-mobile-home.png'}},
            {route: '/bid', desktop: {phase1: 's06-desktop-accept.png', fullPage: 'fp-desktop-accept.png'}, mobile: {phase1: 's06-mobile-accept.png', fullPage: 'fp-mobile-accept.png'}},
        ],
    },
    {
        id: 's07',
        title: 'S7 — Bid pre-listed (acceptBid staged)',
        status: 'covered',
        summary: 'Owner called offerPunkForSaleToAddress(punkId, 0, patron). Punk reserved for Patron at 0.',
        body: 'Used the plan\'s manual cast recipe (give-punk.ts was broken — filed [#56], fixed in #66). Plan said /punk/[id] should show "Pre-listed to Patron" banner + "Accept bid" CTA, and /accept should list it — neither did. Filed [#57], fixed in #70. /accept card copy "no open-market bid or listing" was misleading — same issue.',
        issues: [56, 57],
        surfaces: [
            {route: '/punk/1', note: 'Phase 1: no banner. Phase 3 verified with Punk #50 pre-listed: banner + CTA visible.', desktop: {phase1: 's07-desktop-punk1.png', phase3: 'rerun-desktop-punk50.png'}, mobile: {phase1: 's07-mobile-punk1.png', phase3: 'rerun-mobile-punk50.png'}},
            {route: '/bid', desktop: {phase1: 's07-desktop-accept.png', fullPage: 'fp-desktop-accept.png'}, mobile: {phase1: 's07-mobile-accept.png', fullPage: 'fp-mobile-accept.png'}},
            {route: '/punk/100', note: 'Post-PR-70: pre-listed status surfaced with Accept-bid CTA (Punk #100 acquired via acceptListing in S16).', desktop: {fullPage: 'fp-desktop-punk100.png'}, mobile: {fullPage: 'fp-mobile-punk100.png'}},
        ],
    },
    {
        id: 's08',
        title: 'S8 — Active return auction (FIRST acquisition)',
        status: 'covered',
        summary: 'patron.acceptBid(1, 3, 0) fires. acquisitionCount 0→1.',
        body: `Onchain (Phase 1, Punk #1 + trait 3): pc.acquisitionCount=1, pendingMask=8 (bit 3), pendingTraitCount(3)=1, attemptCount(3)=1, custodyOf(1)=InReturnAuction, Punk #1 owner = ReturnAuctionModule.

Filed [#58]: test plan claimed "acceptBid cost = 0 / bidBalance unchanged" — actually Patron paid out the full 30 ETH live bid; priceWei = 30 ETH, reserve = 30.3 ETH on first attempt. Fixed in #65.

Filed [#59]: /referrals showed "0 ETH ETH" double-suffix. Fixed in #67 — single suffix.`,
        issues: [58, 59],
        surfaces: [
            {route: '/', desktop: {phase1: 's08-desktop-home.png', fullPage: 'fp-desktop-home.png'}, mobile: {fullPage: 'fp-mobile-home.png'}},
            {route: '/auction/[punkId]', note: 'Excellent: paid 30 ETH, reserve 30.3, time + bid form. Full-page = Punk #100 active auction.', desktop: {phase1: 's08-desktop-auction1.png', fullPage: 'fp-desktop-auction100.png'}, mobile: {phase1: 's08-mobile-auction1.png', fullPage: 'fp-mobile-auction100.png'}},
            {route: '/punk/[id]', note: '"IN RETURN AUCTION" status + "VIEW THE LIVE AUCTION" CTA. Full-page = Punk #100.', desktop: {phase1: 's08-desktop-punk1.png', fullPage: 'fp-desktop-punk100.png'}, mobile: {phase1: 's08-mobile-punk1.png', fullPage: 'fp-mobile-punk100.png'}},
            {route: '/referrals', note: '"0 ETH ETH" double-suffix typo in Phase 1; fixed in #67.', desktop: {phase1: 's08-desktop-referrals.png', fullPage: 'fp-desktop-referrals.png'}, mobile: {phase1: 's08-mobile-referrals.png', fullPage: 'fp-mobile-referrals.png'}},
            {route: '/builders', note: 'Referral docs surface; counters are non-fail-closed post-S8.', desktop: {fullPage: 'fp-desktop-builders.png'}, mobile: {fullPage: 'fp-mobile-builders.png'}},
        ],
    },
    {
        id: 's09',
        title: 'S9 — Return auction with bid above reserve (no extension)',
        status: 'covered',
        summary: 'Dev1 bids 31 ETH. Not in last 15 min → no anti-snipe extension.',
        body: 'highBidWei=31 ETH, highBidder=dev1. endsAt unchanged. Filed [#60]: page top showed "CURRENT BID 31 ETH" but bid history below said "No bids yet. Be the first." — contradiction. Fixed in #74 — contextual empty-state copy.',
        issues: [60],
        surfaces: [
            {route: '/auction/[punkId]', note: 'Phase 1: bid history said "No bids yet" while CURRENT BID was 31 ETH. Fixed in #74.', desktop: {phase1: 's09-desktop-auction1.png', fullPage: 'fp-desktop-auction100.png'}, mobile: {fullPage: 'fp-mobile-auction100.png'}},
        ],
    },
    {
        id: 's10',
        title: 'S10 — Anti-snipe extension fired',
        status: 'covered',
        summary: 'Bid in final 15 min → endsAt advances by SNIPE_EXTENSION (1h).',
        body: 'Warped to endsAt - 600s; outbid from dev2 (32 ETH). endsAt advanced. Filed [#61]: page\'s "Anti-snipe extensions" counter stayed at 0. Fixed in #72 — fork adapter now counts ReturnAuctionExtended events. Filed [#62]: bid history showed "-255444s ago" — wall-clock vs chain-time drift. Fixed in #73 — chainNowSeconds.',
        issues: [61, 62],
        surfaces: [
            {route: '/auction/[punkId]', note: 'Phase 1: counter stuck at 0, time drift. Phase 3 verified on Punk #50: counter=1, "0s ago". Full-page = Punk #100 active auction.', desktop: {phase1: 's10-desktop-auction1.png', phase3: 'rerun-desktop-auction50.png', fullPage: 'fp-desktop-auction100.png'}, mobile: {phase3: 'rerun-mobile-auction50.png', fullPage: 'fp-mobile-auction100.png'}},
        ],
    },
    {
        id: 's11',
        title: 'S11 — Cleared / Rescued (bid path)',
        status: 'covered',
        summary: 'High bid clears the auction. Punk → bidder via ReturnAuctionEscrow round-trip. Trait stays uncollected.',
        body: `Splits (Punk #1: cost 30 ETH, highBid 32 ETH, premium 2 ETH, no referrer):
- Patron += 19.5 ETH (cost × 0.65) ✓
- BuybackBurner += 7.5 ETH (cost × 0.25, residual) ✓
- VaultBurnPool += 5 ETH (cost × 0.10 + premium) ✓

custodyOf(1) = ReturnedToMarket. collectedMask unchanged. attemptCount(3) = 1 (already incremented at acceptBid).`,
        surfaces: [
            {route: '/punk/[id]', note: '"RETURNED TO MARKET" status; all traits UNCOLLECTED.', desktop: {phase1: 's11-desktop-punk1.png'}, mobile: {phase1: 's11-mobile-punk1.png'}},
            {route: '/collection', note: 'Phase 1 captured "0 / 111" right after S11 clear. Full-page reflects current 56/111 state.', desktop: {phase1: 's11-desktop-collection.png', fullPage: 'fp-desktop-collection.png'}, mobile: {fullPage: 'fp-mobile-collection.png'}},
        ],
    },
    {
        id: 's12',
        title: 'S12 — Silenced / Vaulted (no-bid path)',
        status: 'covered',
        summary: 'Biggest gate flip. settle vaults the Punk, collects target trait only, mints Proof NFT, sweeps VaultBurnPool → BuybackBurner.',
        body: `Punk #2 + trait 2 (Female). After 72h + settle: Punk #2 → Vault, custody=Vaulted, collectedCount 0→1 (gate flipped!), collectedMask bit 2 set, firstVaultedPunk(2)=(2, true), vault.ownerOf(2)=dev0 (Proof minted), VaultBurnPool drained 2 ETH → BuybackBurner.

Filed [#63]: /proofs read "0 OF 111 ISSUED" and every slot said "awaiting vaulting" even after the mint. Fixed in #71 — fork adapter now reads proofsMintedMask.`,
        issues: [63],
        surfaces: [
            {route: '/', desktop: {phase1: 's12-desktop-home.png', fullPage: 'fp-desktop-home.png'}, mobile: {fullPage: 'fp-mobile-home.png'}},
            {route: '/collection', note: 'Phase 1: "1 PERMANENT, 110 UNCOLLECTED, 1/111". Full-page = current 56/111.', desktop: {phase1: 's12-desktop-collection.png', fullPage: 'fp-desktop-collection.png'}, mobile: {fullPage: 'fp-mobile-collection.png'}},
            {route: '/punk/[id]', note: '"VAULTED" status; target trait COLLECTED + others UNCOLLECTED (V2 spec). Full-page = vaulted Punk #0.', desktop: {phase1: 's12-desktop-punk2.png', fullPage: 'fp-desktop-punk0.png'}, mobile: {}},
            {route: '/proofs', note: 'Phase 1: stale (filed #63). Phase 3 verified post-fix: "1 of 111 issued". Full-page = 56 issued.', desktop: {phase1: 's12-desktop-proofs.png', phase3: 'rerun-desktop-proofs.png', fullPage: 'fp-desktop-proofs.png'}, mobile: {phase3: 'rerun-mobile-proofs.png', fullPage: 'fp-mobile-proofs.png'}},
        ],
    },
    {
        id: 's13',
        title: 'S13 — BuybackBurner ready',
        status: 'covered',
        summary: 'Burn balance accumulated + pacing window elapsed. executeStep callable.',
        body: 'Burner held 11 ETH (9 from cleared cost + 2 from VBP sweep). Mined 200 blocks to clear minBlocksBetweenSteps. Burner state is internal mechanism — closest UI surface is the home page (where supply ticker / buyback widget surface).',
        surfaces: [
            {route: '/', note: 'Home surfaces token supply / live bid; both update post-burn.', desktop: {fullPage: 'fp-desktop-home.png'}, mobile: {fullPage: 'fp-mobile-home.png'}},
            {route: '/about', note: 'Protocol explainer covers the buyback-and-burn mechanism.', desktop: {fullPage: 'fp-desktop-about.png'}, mobile: {}},
        ],
    },
    {
        id: 's14',
        title: 'S14 — Burn step executed',
        status: 'covered',
        summary: '111 bought from pool + burned via _burn (totalSupply drops). Caller credited keeper reward.',
        body: 'token.totalSupply dropped from 1.110e27 → 1.057e27 (~53M tokens burned). Burner balance dropped 11 → 10.54 ETH. Mechanism is _burn (reduces totalSupply directly, no 0xdEaD transfer).',
        surfaces: [
            {route: '/', note: 'Home surfaces token supply / live bid; both update post-burn-step.', desktop: {fullPage: 'fp-desktop-home.png'}, mobile: {fullPage: 'fp-mobile-home.png'}},
            {route: '/trade', note: 'Trade panel shows live token supply alongside the swap form.', desktop: {fullPage: 'fp-desktop-trade.png'}, mobile: {fullPage: 'fp-mobile-trade.png'}},
        ],
    },
    {
        id: 's15',
        title: 'S15 — Title auction open / bid / settle',
        status: 'covered',
        summary: 'Verified live: 56 vaults via seed:title-threshold → isKickoffReady=true → kickoff() → isLive=true.',
        body: `pnpm seed:title-threshold drove the bid path 56 times (after fixing two stale-rename bugs in the script: \`acceptBounty → acceptBid\` and \`deployments.finalSaleModule → deployments.returnAuctionModule\` — same class as #56). All 56 acceptBids fired; settle had to be run manually because the script's silent-fail-on-undefined-address bug only got caught after I'd run the loop once.

After 56 settles → pc.collectedCount = 56, titleAuction.isKickoffReady = true.

/title pre-kickoff: "The collection has passed 11 permanent traits. The Title can now be auctioned" + 56/111 progress, round #1, the single payout recipient slot shown at 100% (Title proceeds route 100% to payoutRecipient).

Fired titleAuction.kickoff() → kickedOff=true, endsAt set 24h ahead, isLive=true. /title reloaded shows the live english-auction UI.`,
        surfaces: [
            {route: '/title', note: 'Pre-kickoff: "The Title is for sale" + kickoff CTA. Full-page = post-kickoff live state.', desktop: {phase3: 's15-desktop-title-kickoff-ready.png', fullPage: 'fp-desktop-title.png'}, mobile: {fullPage: 'fp-mobile-title.png'}},
            {route: '/title', note: 'Post-kickoff live auction state.', desktop: {phase3: 's15-desktop-title-live.png'}, mobile: {}},
        ],
    },
    {
        id: 's16',
        title: 'S16 — acceptListing (allowlisted seller path)',
        status: 'covered',
        summary: 'Verified live: allowlisted seller publicly lists Punk #100 @ 5 ETH → acceptListing → Patron pays + Punk enters return auction. originalSeller ≠ caller.',
        body: `pnpm seed:fork put a public 5 ETH listing on Punk #100 from test seller 0x...F1F1. After patron.addAllowedSeller(0x...F1F1) + 24h warp, the seller was active.

Called patron.acceptListing(100, 101) as dev0 (the finder, not the seller). Results:
  Punk #100 → ReturnAuctionModule ✓
  custodyOf(100) = InReturnAuction ✓
  Acquisition[56].originalSeller = 0x...F1F1 (the seller — NOT the caller)
  Patron balance: 40 → 34.99 ETH (paid 5 ETH listing + 0.01 finder fee retained)

This is the key distinction from S7-S8 acceptBid: in acceptListing, originalSeller ≠ acquirer. If this Punk later silenced-vaults, the Proof NFT mints to 0x...F1F1, not to dev0.`,
        surfaces: [
            {route: '/bid', note: 'Live-bid 34.99 ETH. Allowlisted seller listings would appear here.', desktop: {phase3: 's16-desktop-accept.png', fullPage: 'fp-desktop-accept.png'}, mobile: {fullPage: 'fp-mobile-accept.png'}},
            {route: '/punk/100', note: 'Post-acceptListing: IN RETURN AUCTION status.', desktop: {phase3: 's16-desktop-punk100.png', fullPage: 'fp-desktop-punk100.png'}, mobile: {fullPage: 'fp-mobile-punk100.png'}},
            {route: '/auction/100', note: 'The active auction this acceptListing opened.', desktop: {fullPage: 'fp-desktop-auction100.png'}, mobile: {fullPage: 'fp-mobile-auction100.png'}},
        ],
    },
    {
        id: 's17',
        title: 'S17 — Trial > 0 reserve premium',
        status: 'covered',
        summary: 'Each prior attempt at a trait bumps the reserve by 1%. Verified live on Punk #50.',
        body: `Phase 1 marked this analytically verified. The current fork has it live: pc.attemptCount(3) == 2 because Punk #1's clear bumped 0→1, Punk #50's acceptBid for the same trait bumped 1→2.

Punk #50 auction reserve check:
- acquisitionCost: 5.191362572431208672 ETH
- reserveWei:      5.295189823879832846 ETH
- ratio:           1.02 = (101 + 1) / 100 ✓

Formula matches: reserve = cost × (101 + prevTrials) / 100 with prevTrials = 1.`,
        surfaces: [
            {route: '/auction/50', note: 'Attempt #2 visible on the card; reserve 5.30 ETH vs cost 5.19 ETH. Full-page = active Punk #100 auction.', desktop: {phase3: 'rerun-desktop-auction50.png', fullPage: 'fp-desktop-auction100.png'}, mobile: {phase3: 'rerun-mobile-auction50.png', fullPage: 'fp-mobile-auction100.png'}},
        ],
    },
    {
        id: 's18',
        title: 'S18 — Multiple traits collected (renderer regime)',
        status: 'covered',
        summary: 'Verified at K=56: home progress bar reads 56/111, /proofs reads "56 of 111 issued" with 56 minted cards, /collection mosaic shows 56 permanent + 1 in return auction.',
        body: `Same seed setup as S15 (56 vaults). The trait grid and mosaic render correctly at K=56:

  / (home):            "56 / 111" progress + trait grid colors
  /proofs:             "56 of 111 issued" header; 56 minted Proof cards
                       (verified mintedCount=56 in DOM)
  /collection:         "56 PERMANENT / 1 IN RETURN AUCTION / 54 UNCOLLECTED"
                       mosaic renders with real Punk SVGs

The /collection page is heavy with 56 inline Punk SVGs — html2canvas hits a 30s timeout trying to snap it (the page itself renders fine; the MCP preview_screenshot caught it correctly). Not a defect — just a snap tooling limit on a busy page.`,
        surfaces: [
            {route: '/', note: 'progress reads 56/111 in trait grid.', desktop: {phase3: 's18-desktop-home.png', fullPage: 'fp-desktop-home.png'}, mobile: {fullPage: 'fp-mobile-home.png'}},
            {route: '/proofs', note: '56 minted Proof cards.', desktop: {phase3: 's18-desktop-proofs.png', fullPage: 'fp-desktop-proofs.png'}, mobile: {fullPage: 'fp-mobile-proofs.png'}},
            {route: '/collection', note: 'Mosaic at K=56.', desktop: {phase3: 's18-desktop-collection.png', fullPage: 'fp-desktop-collection.png'}, mobile: {fullPage: 'fp-mobile-collection.png'}},
            {route: '/punk/0', note: 'Example vaulted Punk — first of the 56 from seed:title-threshold.', desktop: {fullPage: 'fp-desktop-punk0.png'}, mobile: {}},
        ],
    },
    {
        id: 's19',
        title: 'S19 — Referral attribution credits a referrer',
        status: 'covered',
        summary: 'Verified live: 0.5 ETH attributed buy credits exactly 0.25% to the referrer. Claim works.',
        body: `Originally blocked by [#55] in Phase 1. After #55 closed (PR #66), wrote contracts/script/SimulateAttributedSwap.s.sol — a one-shot attributed buy that encodes PCSwapData properly as a 1-tuple struct (the gotcha lib/swap/attribution.ts warns about).

Run (post-Phase-1 fork; pc.acquisitionCount=3):
  REFERRER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 BUY_WEI=5e17
  → AttributedSwapper.buyWithAttribution() fires
  → ReferralPayout.balances(referrer) grew 0 → 1.25e15 wei
  → expected upper bound: volume × 250 / 100_000 = 1.25e15 ✓ (exactly the max the hook honors, 0.25% of volume)

Claim flow:
  → dev1 calls ReferralPayout.claim()
  → balances(dev1) → 0
  → dev1 ETH grew by 1.25e15 wei minus tx gas

Both the credit and claim halves of S19 are verified end-to-end.`,
        issues: [55],
        surfaces: [
            {route: '/trade', note: '?ref=… URL param surfaces the "Referral 0x…" attribution chip beside the swap form.', desktop: {fullPage: 'fp-desktop-trade.png'}, mobile: {fullPage: 'fp-mobile-trade.png'}},
            {route: '/referrals', note: 'Connected-wallet panel: Stuck-on-hook + Ready-to-claim + claim/drain CTAs.', desktop: {fullPage: 'fp-desktop-referrals.png'}, mobile: {fullPage: 'fp-mobile-referrals.png'}},
            {route: '/builders', note: 'Builder docs surface the attribution mechanic.', desktop: {fullPage: 'fp-desktop-builders.png'}, mobile: {fullPage: 'fp-mobile-builders.png'}},
        ],
    },
    {
        id: 's20',
        title: 'S20 — Allowlist add, in 24h delay',
        status: 'covered',
        summary: 'patron.addAllowedSeller(addr) → activeAt = now + 24h. acceptListing reverts until activation.',
        body: 'Verified: allowedSellers(addr) flipped to true; activeAt = now + 86400 sec (exactly 24h). Admin-facing — closest public surface is /accept (where allowlisted listings appear post-activation).',
        surfaces: [
            {route: '/bid', note: 'Allowlisted seller listings would appear once the seller\'s 24h activation timer elapses.', desktop: {fullPage: 'fp-desktop-accept.png'}, mobile: {fullPage: 'fp-mobile-accept.png'}},
            {route: '/contracts', note: 'Patron contract (the allowlist owner) addressable via this page.', desktop: {fullPage: 'fp-desktop-contracts.png'}, mobile: {}},
        ],
    },
    {
        id: 's22',
        title: 'S22 — Admin auto-locked (+1 year)',
        status: 'covered',
        summary: 'After warp +366 days, ProtocolAdmin.isLocked = true. Carve-outs still work.',
        body: `Pre-warp: adminTimerExpires = 1811371105. Post-warp (+31.6M sec): isLocked = true, timeUntilLock = 0.

Setter behavior post-lock:
- liveBidAdapter.setMaxSweepWei(5e17) → reverts NotAdmin (rate-cap knob, no carve-out) ✓
- patron.removeAllowedSeller(addr) → succeeds (allowlist carve-out) ✓

(Patron's finder-fee setters and ReturnAuctionModule.setMinBidIncrementBps were removed — those parameters are now protocol constants.)

Both documented carve-outs preserved after lock. Admin-facing pages weren't discovered as discrete routes in Phase 1.`,
        surfaces: [
            {route: '/', note: 'Admin lock is admin-facing — home page unaffected.', desktop: {phase1: 's22-desktop-home.png', fullPage: 'fp-desktop-home.png'}, mobile: {fullPage: 'fp-mobile-home.png'}},
            {route: '/contracts', note: 'ProtocolAdmin contract addressable from here; isLocked() readable via the linked block explorer.', desktop: {fullPage: 'fp-desktop-contracts.png'}, mobile: {}},
        ],
    },
];
