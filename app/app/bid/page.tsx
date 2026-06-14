import type { Metadata } from "next";
import Link from "next/link";
import { AcceptBidFlow } from "@/components/AcceptBidFlow";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { SoldPunksHistory } from "@/components/SoldPunksHistory";
import { getDataAdapter } from "@/lib/data";
import { buildMeta } from "@/lib/meta";

export const metadata: Metadata = buildMeta({
  title: "Accept the bid",
  description: "111 Punk traits. One permanent collection. One public bid.",
  path: "/bid",
});

export const dynamic = "force-dynamic";

export default async function BidPage() {
  const adapter = getDataAdapter();
  const [state, market, traitNames] = await Promise.all([
    adapter.getProtocolState(),
    adapter.getMarketReference(),
    adapter.getTraitNames(),
  ]);

  return (
    <>
      <Header />
      <main id="top">
        <section className="accept-page">
          <div className="wrap">
            <div className="kicker">Accept the bid</div>
            <h1 className="section-title">
              111 Punk traits.
              <br />
              One permanent collection.
              <br />
              One public bid.
            </h1>
            <p className="section-copy">
              The protocol stands at a single live bid. You can accept it for
              any Punk you own that carries an uncollected trait. The Punk
              enters a 72-hour return auction. If the market does not bid above
              the reserve, your Punk goes to the vault forever and the protocol
              makes permanent the rarest uncollected trait it carries. You
              don&apos;t choose that trait; the protocol derives it, the same
              way for every eligible Punk.{" "}
              <Link
                className="accept-faq-link"
                href="/faq#which-trait-becomes-permanent"
              >
                How the trait is chosen
              </Link>
              .
            </p>
            <AcceptBidFlow
              liveBidWei={state.liveBidWei.toString()}
              asOfBlock={state.asOfBlock.toString()}
              asOfTimestamp={state.asOfTimestamp.toString()}
              marketAvailable={market.available}
              cheapestEligibleWei={market.cheapestEligiblePriceWei?.toString()}
              floorWei={market.floorPriceWei?.toString()}
              traitNames={traitNames}
            />
            {/* Survives a reload: reads the wallet's withdrawable
                            balance straight from the market + lists past sales,
                            so the claim is reachable outside the live accept
                            session. Renders nothing until a wallet with history
                            or a claimable balance is connected. */}
            <SoldPunksHistory />
          </div>
        </section>
      </main>
      <Footer />
      <style>{styles}</style>
    </>
  );
}

const styles = `
.accept-page {
    padding-top: clamp(60px, 9vh, 100px);
    padding-bottom: clamp(80px, 12vh, 160px);
    border-top: none;
}
.accept-faq-link {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 3px;
}
`;
