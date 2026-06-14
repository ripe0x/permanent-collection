import type { Metadata } from "next";

import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { ReferralClaim } from "@/components/ReferralClaim";
import { getTokenSymbol } from "@/lib/config";
import { buildMeta } from "@/lib/meta";
import { FEES, fmtPct } from "@/lib/protocol-params";

const TOKEN_SYMBOL = getTokenSymbol();

export const dynamic = "force-dynamic";

export const metadata: Metadata = buildMeta({
  title: "Referrals",
  description: `Claim referral earnings from swaps you routed to the official ${TOKEN_SYMBOL} pool.`,
  path: "/referrals",
});

export default function ReferralsPage() {
  return (
    <>
      <Header />
      <main id="top">
        <section className="referrals-page">
          <div className="wrap">
            <div className="kicker">For referrers</div>
            <h1 className="section-title">Referral earnings.</h1>
            <p className="section-copy">
              When someone swaps through the canonical ${TOKEN_SYMBOL} pool with
              your address attributed as the referrer,{" "}
              {fmtPct(FEES.referralCapPct)} of their swap volume routes to you.
            </p>

            <ReferralClaim />
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
