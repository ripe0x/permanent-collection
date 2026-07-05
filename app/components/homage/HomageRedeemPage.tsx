'use client';

import {useState} from 'react';
import Link from 'next/link';
import {ConnectButton} from '@rainbow-me/rainbowkit';
import {formatEther} from 'viem';

import {getChainId} from '@/lib/config';
import {getEvmNowTxUrl} from '@/lib/format';
import {useRedeem, useHomageArt} from '@/lib/homage/useHomageMint';

const eth = (x?: bigint, dp = 4) => (x === undefined ? '—' : Number(formatEther(x)).toFixed(dp));

export function HomageRedeemPage() {
    const r = useRedeem();
    return (
        <div className="atelier min-h-screen">
            <header className="mx-auto max-w-[1120px] px-6 sm:px-8 h-16 flex items-center justify-between">
                <Link href="/homage" className="font-mono text-[11px] tracking-[0.28em] uppercase text-ink">homage to the punk</Link>
                <div className="flex items-center gap-5">
                    <Link href="/homage" className="font-mono text-[12px] text-dim hover:text-ink">mint →</Link>
                    <ConnectButton.Custom>
                        {({account, chain, openConnectModal, openAccountModal, openChainModal, mounted}) => {
                            if (!mounted) return <div className="btn-connect opacity-0">connect</div>;
                            if (!account) return <button onClick={openConnectModal} className="btn-connect">Connect</button>;
                            if (chain?.unsupported) return <button onClick={openChainModal} className="btn-connect">Wrong network</button>;
                            return <button onClick={openAccountModal} className="btn-connect">{account.displayName}</button>;
                        }}
                    </ConnectButton.Custom>
                </div>
            </header>
            <div className="h-px bg-line" />

            <main className="mx-auto max-w-[1120px] px-6 sm:px-8 pb-24">
                <section className="py-12 sm:py-16">
                    <div className="eyebrow-a">redeem</div>
                    <h1 className="display-sm mt-3">Your homages</h1>
                    <p className="text-[14px] leading-[1.5] text-dim mt-3 max-w-[46ch]">
                        Burn a homage to reclaim the 50,000 $111 locked inside it, in full. A small ETH fee applies, and the punk id
                        returns to the pool.
                    </p>

                    <div className="mt-8">
                        {!r.configured ? (
                            <p className="font-mono text-[12px] text-faint">No contract deployed yet.</p>
                        ) : !r.isConnected ? (
                            <ConnectButton.Custom>
                                {({openConnectModal}) => (
                                    <button onClick={openConnectModal} className="btn-primary">Connect wallet</button>
                                )}
                            </ConnectButton.Custom>
                        ) : r.wrongChain ? (
                            <ConnectButton.Custom>
                                {({openChainModal}) => (
                                    <button onClick={openChainModal} className="btn-primary">Switch to {r.chainName}</button>
                                )}
                            </ConnectButton.Custom>
                        ) : r.owned.status === 'loading' ? (
                            <p className="font-mono text-[12px] text-faint">scanning your homages…</p>
                        ) : r.owned.status === 'error' ? (
                            <p className="font-mono text-[12px] text-[#b4431f]">couldn’t scan ownership.</p>
                        ) : r.owned.ids.length === 0 ? (
                            <p className="font-mono text-[12px] text-faint">
                                nothing to redeem — <Link href="/homage" className="underline underline-offset-2 hover:text-ink">mint one</Link>.
                            </p>
                        ) : (
                            <>
                                {r.owned.status === 'partial' && (
                                    <p className="font-mono text-[11px] text-faint mb-4">showing recently-minted homages (partial scan).</p>
                                )}
                                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-4">
                                    {r.owned.ids.map((id) => (
                                        <RedeemCard key={id} id={id} r={r} />
                                    ))}
                                </div>
                            </>
                        )}
                    </div>

                    <RedeemNote r={r} />
                </section>
            </main>
        </div>
    );
}

function RedeemCard({id, r}: {id: number; r: ReturnType<typeof useRedeem>}) {
    const {src} = useHomageArt(id);
    const [confirming, setConfirming] = useState(false);
    const busy = r.redeemStatus === 'confirm' || r.redeemStatus === 'pending';
    return (
        <div className="group">
            <div className="art-frame art-frame--sm">
                {src ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={src} alt={`#${id}`} className="art-img" />
                ) : (
                    <div className="art-skeleton" />
                )}
            </div>
            <div className="flex items-center justify-between mt-2">
                <span className="font-mono text-[11px] text-dim">#{id}</span>
                {!confirming && (
                    <button
                        onClick={() => setConfirming(true)}
                        disabled={busy}
                        className="font-mono text-[10px] uppercase tracking-[0.1em] text-faint hover:text-ink disabled:opacity-40"
                    >
                        redeem
                    </button>
                )}
            </div>
            {confirming && (
                <div className="mt-2 border border-line p-2.5">
                    {/* explicit consequence line — spell out exactly what redeeming does before the tx */}
                    <p className="font-mono text-[10px] text-dim leading-[1.5]">
                        Burns Homage #{id}, returns 50,000 $111 to your wallet, and puts punk #{id} back in the mintable pool.
                    </p>
                    <p className="font-mono text-[10px] text-faint mt-1.5">
                        Exit fee: {eth(r.exitFee)} ETH
                    </p>
                    <div className="flex gap-2 mt-2">
                        <button
                            onClick={() => r.redeem(id)}
                            disabled={busy}
                            className="flex-1 font-mono text-[10px] uppercase tracking-[0.1em] border border-ink text-ink py-1 hover:bg-ink hover:text-white disabled:opacity-40"
                        >
                            {busy ? 'redeeming…' : 'confirm redeem'}
                        </button>
                        <button
                            onClick={() => setConfirming(false)}
                            disabled={busy}
                            className="font-mono text-[10px] uppercase tracking-[0.1em] text-faint hover:text-ink disabled:opacity-40 px-2"
                        >
                            cancel
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

function RedeemNote({r}: {r: ReturnType<typeof useRedeem>}) {
    if (r.redeemStatus === 'idle' && !r.redeemError) return null;
    return (
        <div className="mt-6 font-mono text-[11px] leading-relaxed">
            {r.redeemStatus === 'confirm' && <span className="text-dim">confirm in your wallet…</span>}
            {r.redeemStatus === 'pending' && <span className="text-dim">redeeming…</span>}
            {r.redeemStatus === 'success' && (
                <span className="text-ink">redeemed ✓ 50,000 $111 returned{r.redeemedId !== null ? ` · #${r.redeemedId}` : ''}</span>
            )}
            {r.redeemError && <span className="text-[#b4431f] break-words">{r.redeemError}</span>}
            {r.redeemHash && (r.redeemStatus === 'pending' || r.redeemStatus === 'success') && (
                <a
                    className="ml-2 text-dim underline-offset-2 hover:underline"
                    href={getEvmNowTxUrl(r.redeemHash, getChainId())}
                    target="_blank"
                    rel="noreferrer"
                >
                    view transaction ↗
                </a>
            )}
        </div>
    );
}
