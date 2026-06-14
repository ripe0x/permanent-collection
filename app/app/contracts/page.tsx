import type {Metadata} from 'next';
import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {
    getChainId,
    getContractAddresses,
    getTokenSymbol,
    getV4Infrastructure,
} from '@/lib/config';
import {ContractAddress} from '@/components/ContractAddress';
import {buildMeta} from '@/lib/meta';
import {FEES, fmtPct} from '@/lib/protocol-params';

const TOKEN_SYMBOL = getTokenSymbol();

export const metadata: Metadata = buildMeta({
    title: 'Contracts — Permanent Collection',
    description:
        'Deployed contract addresses for the Permanent Collection protocol — core, fee adapters, renderer, plus the canonical Punks + Uniswap V4 infrastructure it integrates with.',
    path: '/contracts',
});

type Row = {label: string; address: string; note?: string};

export default function ContractsPage() {
    const chainId = getChainId();
    const addrs = getContractAddresses();
    const v4 = getV4Infrastructure();

    const core: Row[] = [
        {label: 'PermanentCollection', address: addrs.permanentCollection, note: 'Records-only core'},
        {label: 'Patron', address: addrs.patron, note: 'Live-bid hub'},
        {label: 'ReturnAuctionModule', address: addrs.returnAuctionModule, note: '72h return auction'},
        {label: 'PunkVault', address: addrs.punkVault, note: 'Vault + Proof + Title NFTs'},
        ...(addrs.titleAuction
            ? [{label: 'PunkVaultTitleAuction', address: addrs.titleAuction, note: 'Title token id 111'}]
            : []),
        {label: 'ProtocolAdmin', address: addrs.protocolAdmin, note: '1y auto-locking admin'},
    ];

    const fees: Row[] = [
        {label: 'LiveBidAdapter', address: addrs.liveBidAdapter, note: `Bid leg (${fmtPct(FEES.bidLegPct)} of volume) + LP fee → Patron`},
        {label: 'VaultBurnPool', address: addrs.vaultBurnPool, note: 'Accumulator (fed by cleared auctions) → BuybackBurner'},
        ...(addrs.protocolFeePhaseAdapter
            ? [
                  {
                      label: 'ProtocolFeePhaseAdapter',
                      address: addrs.protocolFeePhaseAdapter,
                      note: `Protocol leg (${fmtPct(FEES.protocolLegPct)} of volume), sweeps to PCController`,
                  },
              ]
            : []),
        ...(addrs.referralPayout
            ? [
                  {
                      label: 'ReferralPayout',
                      address: addrs.referralPayout,
                      note: 'Pull-based referrer ledger',
                  },
              ]
            : []),
        {label: 'BuybackBurner', address: addrs.buybackBurner, note: `${TOKEN_SYMBOL} buyback + burn`},
    ];

    const composability: Row[] = [
        ...(addrs.pcSwapContext
            ? [
                  {
                      label: 'PCSwapContext',
                      address: addrs.pcSwapContext,
                      note: 'Transient reentrancy registry (Design B)',
                  },
              ]
            : []),
    ];

    const render: Row[] = [
        {label: 'Renderer', address: addrs.renderer, note: 'Mosaic renderer'},
    ];

    const token: Row[] = [
        {label: `${TOKEN_SYMBOL} (token)`, address: addrs.token, note: 'ERC20'},
    ];

    const external: Row[] = [
        {
            label: 'CryptoPunksMarket',
            address: addrs.punksMarket,
            note: '2017 canonical (mainnet)',
        },
        {label: 'PunksData', address: addrs.punksData, note: 'Sealed trait + pixel data'},
        {label: 'V4 PoolManager', address: v4.poolManager},
        {label: 'V4 Universal Router', address: v4.universalRouter},
        {label: 'V4 Quoter', address: v4.quoter},
        {label: 'V4 StateView', address: v4.stateView},
        {label: 'Permit2', address: v4.permit2},
        {label: 'WETH', address: v4.weth},
    ];

    return (
        <>
            <Header />
            <main id="top">
                <section className="contracts-hero" aria-label="Contracts">
                    <div className="wrap">
                        <div className="kicker">Contracts</div>
                        <h1 className="contracts-h1">
                            Deployed addresses ({chainId === 1 ? 'mainnet' : `chain ${chainId}`}).
                        </h1>
                        <p className="contracts-lede">
                            Every contract that participates in the protocol. Core and fee
                            adapters are PC-owned; render and token are deployed via the
                            artcoins factory; the externals are the canonical mainnet
                            infrastructure the protocol builds on.
                        </p>
                    </div>
                </section>

                <section className="contracts-section" aria-label="Permanent core">
                    <div className="wrap">
                        <h2 className="contracts-h2">Permanent core</h2>
                        <ContractTable rows={core} chainId={chainId} />
                    </div>
                </section>

                <section className="contracts-section" aria-label="Fees + adapters">
                    <div className="wrap">
                        <h2 className="contracts-h2">Fees + adapters</h2>
                        <ContractTable rows={fees} chainId={chainId} />
                    </div>
                </section>

                {composability.length > 0 && (
                    <section className="contracts-section" aria-label="Composability">
                        <div className="wrap">
                            <h2 className="contracts-h2">Composability surface</h2>
                            <ContractTable rows={composability} chainId={chainId} />
                        </div>
                    </section>
                )}

                <section className="contracts-section" aria-label="Render">
                    <div className="wrap">
                        <h2 className="contracts-h2">Render</h2>
                        <ContractTable rows={render} chainId={chainId} />
                    </div>
                </section>

                <section className="contracts-section" aria-label="Token">
                    <div className="wrap">
                        <h2 className="contracts-h2">Token</h2>
                        <ContractTable rows={token} chainId={chainId} />
                    </div>
                </section>

                <section className="contracts-section" aria-label="External integrations">
                    <div className="wrap">
                        <h2 className="contracts-h2">External integrations</h2>
                        <ContractTable rows={external} chainId={chainId} alwaysLive />
                    </div>
                </section>

            </main>
            <Footer />
            <style>{styles}</style>
        </>
    );
}

function ContractTable({
    rows,
    chainId,
    alwaysLive = false,
}: {
    rows: Row[];
    chainId: number;
    alwaysLive?: boolean;
}) {
    return (
        <div className="contracts-table" role="table">
            {rows.map(({label, address, note}) => (
                <div className="contracts-row" role="row" key={`${label}-${address}`}>
                    <div className="contracts-cell contracts-label" role="cell">
                        <span>{label}</span>
                        {note && <span className="contracts-note">{note}</span>}
                    </div>
                    <div className="contracts-cell contracts-addr tnum" role="cell">
                        <ContractAddress address={address} chainId={chainId} alwaysLive={alwaysLive} />
                    </div>
                </div>
            ))}
        </div>
    );
}

const styles = `
.contracts-hero {
    padding: 72px var(--pad) 36px;
}
.contracts-h1 {
    font-family: var(--serif);
    font-weight: 300;
    font-size: clamp(28px, 4.4vw, 44px);
    line-height: 1.12;
    letter-spacing: -0.035em;
    margin: 14px 0 18px;
    max-width: 24ch;
}
.contracts-lede {
    font-family: var(--sans);
    font-size: 16px;
    max-width: 56ch;
    color: var(--muted);
    line-height: 1.6;
}
.contracts-section {
    padding: 28px var(--pad);
}
.contracts-h2 {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 0 0 16px;
}
.contracts-table {
    border-top: 1px solid var(--line);
}
.contracts-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 16px;
    align-items: center;
    padding: 12px 0;
    border-bottom: 1px solid var(--line);
    font-size: 14px;
}
.contracts-label {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.contracts-note {
    color: var(--muted);
    font-size: 12px;
}
.contracts-addr a {
    color: var(--ink);
    text-decoration: none;
    border-bottom: 1px dotted var(--muted);
}
.contracts-addr a:hover {
    border-bottom-color: var(--ink);
}
.contracts-pending {
    color: var(--muted);
    font-style: italic;
}
.contracts-more {
    color: var(--muted);
    font-size: 13px;
    padding: 12px 0 36px;
}
.contracts-more a {
    color: var(--ink);
    border-bottom: 1px dotted var(--muted);
}
`;
