/* PunkStrategy listings panel. Surfaces public 2017-market listings by
   allowlisted sellers (PunkStrategy at launch) that any visitor can accept
   into the protocol via `Patron.acceptListing(punkId, targetTraitId)`. The
   caller pays gas; Patron buys the listing via `buyPunk`, so the 2017 market
   pays the seller; the caller earns the finder fee from the live bid. Hides
   itself when empty so it doesn't take dead real estate.

   Snapshot pricing: rows are computed server-side. Between render and
   click, the live bid / listing / allowlist can change; we surface the
   listed price + finder fee preview as of fetch time. The actual tx
   uses live state, so a partial drift is harmless (revert at worst).
*/

'use client';

import {useState} from 'react';
import type {ReactNode} from 'react';
import {usePublicClient, useWalletClient} from 'wagmi';
import {decodeErrorResult} from 'viem';
import {abi as PatronAbi} from '@/lib/abis/Patron';
import {classifyCarrierTier} from '@/lib/carrierTier';
import {getContractAddresses, getChainId} from '@/lib/config';
import type {ListedTraitListing, ListedTraitOption} from '@/lib/data/types';
import {
    formatEth,
    formatPunk,
    formatRelative,
    formatTraitName,
    getEvmNowTxUrl,
    shortAddress,
} from '@/lib/format';

export function PunkStrategyListings({
    options,
    traitNames,
    punkThumbs,
}: {
    options: ListedTraitOption[];
    traitNames: readonly string[];
    /** Server-rendered <PunkSvg> per punkId, keyed by punkId. Passed in
     *  by the server parent (home page) so the 2.4MB pixel SDK never
     *  reaches this client island. Rows without a matching thumb render
     *  with no image (graceful fallback). */
    punkThumbs?: Record<number, ReactNode>;
}) {
    if (options.length === 0) return null;

    return (
        <section className="ps-listings" aria-label="Traits from public listings">
            <div className="wrap">
                <div className="ps-listings-inner">
                    <div className="ps-listings-header">
                        <h2 className="ps-listings-title">traits from public listings</h2>
                        <p className="ps-listings-sub">
                            Public Punks listed by allowlisted sellers at or below the live bid, grouped by the trait the
                            protocol would make permanent — the rarest uncollected trait each carries. Accept one to send
                            it into a 72-hour return auction and earn the finder fee.
                        </p>
                    </div>
                    <ul className="ps-trait-list">
                        {options.map((opt) => (
                            <ListedTraitGroup
                                key={opt.traitId}
                                option={opt}
                                traitNames={traitNames}
                                punkThumbs={punkThumbs}
                            />
                        ))}
                    </ul>
                </div>
            </div>
            <style>{styles}</style>
        </section>
    );
}

function ListedTraitGroup({
    option,
    traitNames,
    punkThumbs,
}: {
    option: ListedTraitOption;
    traitNames: readonly string[];
    punkThumbs?: Record<number, ReactNode>;
}) {
    const carrier = classifyCarrierTier(option.carrierCount, option.group);
    return (
        <li className="ps-trait-group">
            <div className="ps-trait-head">
                <span className="ps-trait-name">
                    {formatTraitName(option.traitId, traitNames)}
                    {option.uniqueCarrier ? (
                        <span className="ps-trait-badge">only carrier</span>
                    ) : (
                        carrier.tier === 'few' && (
                            <span className="ps-trait-badge ps-trait-badge-rare">rare trait</span>
                        )
                    )}
                </span>
                <span className="ps-trait-meta">
                    {option.carrierCount.toLocaleString('en-US')} of 10,000 Punks
                </span>
            </div>
            {carrier.tier === 'few' && (
                <p className="ps-trait-fewcarrier">
                    {carrier.doublyRare
                        ? `Only ${option.carrierCount} Punks carry this. The Alien and Ape clusters share carriers across type and head, so accepting one is the only route to two permanent traits. Handle it deliberately.`
                        : `Only ${option.carrierCount} Punks carry this. Once one is vaulted the protocol makes just this trait permanent, with little margin to bring it in later.`}
                </p>
            )}
            <ul className="ps-punk-rows">
                {option.listings.map((l) => (
                    <ListedPunkRow
                        key={l.punkId}
                        traitId={option.traitId}
                        listing={l}
                        traitNames={traitNames}
                        thumb={punkThumbs?.[l.punkId]}
                    />
                ))}
            </ul>
        </li>
    );
}

type TxState =
    | {kind: 'idle'}
    | {kind: 'sending'}
    | {kind: 'sent'; hash: `0x${string}`}
    | {kind: 'confirmed'; hash: `0x${string}`}
    | {kind: 'failed'; hash?: `0x${string}`; message: string};

function ListedPunkRow({
    traitId,
    listing,
    traitNames,
    thumb,
}: {
    traitId: number;
    listing: ListedTraitListing;
    traitNames: readonly string[];
    thumb?: ReactNode;
}) {
    const {data: wallet} = useWalletClient();
    const pub = usePublicClient();
    const [tx, setTx] = useState<TxState>({kind: 'idle'});

    // The (Punk, trait) pairing is fixed by the group it sits under — `traitId`
    // is the protocol-derived target (the rarest uncollected trait the Punk
    // carries, computed server-side rarest-first), which is exactly what
    // `acceptListing` requires (`canonicalTargetOf`). If the canonical target
    // shifts between this snapshot and inclusion (someone else collects/pends
    // the rarest trait), the contract reverts `NotCanonicalTarget` /
    // `TargetNotCanonical`; we decode that and tell the visitor to refresh.
    const accept = async () => {
        if (!wallet || !pub) return;
        setTx({kind: 'sending'});
        try {
            const addrs = getContractAddresses();
            const hash = await wallet.writeContract({
                address: addrs.patron,
                abi: PatronAbi,
                functionName: 'acceptListing',
                args: [listing.punkId, traitId],
            });
            setTx({kind: 'sent', hash});
            const receipt = await pub.waitForTransactionReceipt({hash});
            setTx({
                kind: receipt.status === 'success' ? 'confirmed' : 'failed',
                hash,
                ...(receipt.status === 'success'
                    ? {}
                    : {message: 'acceptListing reverted on-chain.'}),
            } as TxState);
        } catch (err) {
            setTx({kind: 'failed', message: classifyAcceptListingError(err, traitNames)});
        }
    };

    const pending = tx.kind === 'sending' || tx.kind === 'sent';
    const chainId = getChainId();

    return (
        <li className="ps-listings-row">
            {thumb && <div className="ps-listings-thumb">{thumb}</div>}
            <div className="ps-listings-meta">
                <div className="ps-listings-line1">
                    <strong>{formatPunk(listing.punkId)}</strong>
                    <span className="ps-listings-sep" aria-hidden="true">·</span>
                    <span className="ps-listings-seller">listed by {shortAddress(listing.seller)}</span>
                    <span className="ps-listings-sep" aria-hidden="true">·</span>
                    <span className="ps-listings-time">{formatRelative(listing.listedAt)}</span>
                </div>
                <div className="ps-listings-line3">
                    <span className="ps-listings-price">{formatEth(listing.minValueWei)} listed</span>
                    <span className="ps-listings-sep" aria-hidden="true">·</span>
                    <span className="ps-listings-fee">you earn {formatEth(listing.finderFeeWei)}</span>
                </div>
            </div>
            <div className="ps-listings-action">
                <button
                    type="button"
                    className="ps-listings-btn"
                    onClick={accept}
                    disabled={!wallet || pending}
                >
                    {tx.kind === 'sending'
                        ? 'sending…'
                        : tx.kind === 'sent'
                          ? 'confirming…'
                          : tx.kind === 'confirmed'
                            ? 'accepted'
                            : 'accept'}
                </button>
                {tx.kind !== 'idle' && tx.kind !== 'sending' && 'hash' in tx && tx.hash && (
                    <a
                        href={getEvmNowTxUrl(tx.hash, chainId)}
                        target="_blank"
                        rel="noreferrer"
                        className="ps-listings-txlink"
                    >
                        view tx
                    </a>
                )}
                {tx.kind === 'failed' && <span className="ps-listings-error">{tx.message}</span>}
            </div>
        </li>
    );
}

/** Decode an `acceptListing` revert into a one-line, voice-correct message.
 *  The headline case is the protocol-derived target shifting before inclusion
 *  (`NotCanonicalTarget` from Patron's early check / `TargetNotCanonical` from
 *  PermanentCollection) — both carry `[punkId, provided, canonical]`, so we can
 *  name the new target and tell the visitor to refresh. `NoEligibleTarget`
 *  means nothing collectable remains on the Punk. Walks the viem cause chain
 *  for the decoded revert (`cause.data.errorName`), falling back to raw
 *  `data`-hex decode against PatronAbi, then to the first error line. */
function classifyAcceptListingError(err: unknown, traitNames: readonly string[]): string {
    const decoded = extractDecodedRevert(err) ?? decodeFromRawData(err);
    if (decoded) {
        if (decoded.errorName === 'NotCanonicalTarget' || decoded.errorName === 'TargetNotCanonical') {
            const canonical = Number(decoded.args?.[2] ?? -1);
            const name = traitNames[canonical];
            return name
                ? `The target trait shifted before your transaction landed (now ${name}). Refresh and try again.`
                : 'The target trait shifted before your transaction landed. Refresh and try again.';
        }
        if (decoded.errorName === 'NoEligibleTarget') {
            return 'This Punk has no collectable trait left — every trait it carries is already permanent or in an active return auction.';
        }
        if (decoded.errorName === 'TargetTraitPending') {
            return 'The target trait just entered another return auction. Refresh and try again.';
        }
        if (decoded.errorName === 'TargetTraitAlreadyCollected') {
            return 'The target trait became permanent before your transaction landed. Refresh and try again.';
        }
        if (decoded.errorName === 'SoleCarrierMustTargetTrait') {
            return 'This Punk is the only carrier of an uncollected trait, so the protocol can only make that trait permanent through it.';
        }
        return `Reverted: ${decoded.errorName}`;
    }
    return err instanceof Error ? err.message.split('\n')[0] : String(err);
}

/** Walk a viem error chain for an already-decoded custom revert: viem 2.x
 *  exposes it at `cause.data = {errorName, args, ...}`. */
function extractDecodedRevert(
    e: unknown,
): {errorName: string; args?: readonly unknown[]} | undefined {
    if (!e || typeof e !== 'object') return undefined;
    const candidates: unknown[] = [e];
    while (candidates.length > 0) {
        const cur = candidates.shift();
        if (!cur || typeof cur !== 'object') continue;
        const obj = cur as Record<string, unknown>;
        const d = obj.data as Record<string, unknown> | undefined;
        if (d && typeof d === 'object' && typeof d.errorName === 'string') {
            const args = Array.isArray(d.args) ? (d.args as readonly unknown[]) : undefined;
            return {errorName: d.errorName, args};
        }
        if (obj.cause) candidates.push(obj.cause);
    }
    return undefined;
}

/** Fallback: pull the raw revert `data` hex from the chain and decode it
 *  against PatronAbi (for providers that bypass viem's contract simulation). */
function decodeFromRawData(
    e: unknown,
): {errorName: string; args?: readonly unknown[]} | undefined {
    const data = extractRevertData(e);
    if (!data) return undefined;
    try {
        const decoded = decodeErrorResult({abi: PatronAbi, data});
        return {errorName: decoded.errorName, args: decoded.args as readonly unknown[] | undefined};
    } catch {
        return undefined;
    }
}

/** Extract a 0x-prefixed revert-`data` field from a viem error chain. */
function extractRevertData(e: unknown): `0x${string}` | undefined {
    if (!e || typeof e !== 'object') return undefined;
    const candidates: unknown[] = [e];
    while (candidates.length > 0) {
        const cur = candidates.shift();
        if (!cur || typeof cur !== 'object') continue;
        const obj = cur as Record<string, unknown>;
        if (typeof obj.data === 'string' && obj.data.startsWith('0x')) {
            return obj.data as `0x${string}`;
        }
        if (obj.cause) candidates.push(obj.cause);
        if (Array.isArray(obj.metaMessages)) {
            for (const m of obj.metaMessages) {
                if (typeof m === 'string') {
                    const match = m.match(/0x[0-9a-fA-F]{8,}/);
                    if (match) return match[0] as `0x${string}`;
                }
            }
        }
    }
    return undefined;
}

const styles = `
.ps-listings {
    padding: 32px 0;
}
.ps-listings-inner {
    max-width: 720px;
}
.ps-listings-header {
    margin-bottom: 14px;
}
.ps-listings-title {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 0 0 8px;
}
.ps-listings-sub {
    font-family: var(--sans);
    font-size: 13px;
    color: var(--muted);
    line-height: 1.5;
    margin: 0;
    max-width: 580px;
}
.ps-listings-list {
    list-style: none;
    padding: 0;
    margin: 0;
}
.ps-trait-list {
    list-style: none;
    padding: 0;
    margin: 0;
}
.ps-trait-group {
    border-top: 1px solid var(--line);
    padding: 14px 0 8px;
}
.ps-trait-group:last-child {
    border-bottom: 1px solid var(--line);
}
.ps-trait-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 4px;
}
.ps-trait-name {
    font-family: var(--sans);
    font-size: 15px;
    color: var(--ink);
    display: flex;
    align-items: center;
    gap: 8px;
}
.ps-trait-badge {
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--accent);
    border: 1px solid var(--accent);
    padding: 1px 5px;
}
.ps-trait-badge-rare {
    color: var(--muted);
    border-color: var(--muted);
}
.ps-trait-fewcarrier {
    font-family: var(--sans);
    font-size: 12px;
    line-height: 1.55;
    color: var(--muted);
    margin: 0 0 8px;
    max-width: 580px;
    border-left: 2px solid var(--accent);
    padding-left: 12px;
}
.ps-trait-meta {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
}
.ps-punk-rows {
    list-style: none;
    padding: 0;
    margin: 0;
}
.ps-listings-row {
    display: grid;
    grid-template-columns: 48px 1fr auto;
    gap: 14px;
    align-items: center;
    padding: 8px 0;
}
.ps-listings-row:not(:has(.ps-listings-thumb)) {
    grid-template-columns: 1fr auto;
}
.ps-listings-thumb {
    width: 48px;
    height: 48px;
    line-height: 0;
    border: 1px solid var(--line);
    background: #fff;
    overflow: hidden;
}
.ps-listings-thumb .punk-svg,
.ps-listings-thumb svg { width: 100%; height: 100%; image-rendering: pixelated; }
.ps-punk-rows .ps-listings-row + .ps-listings-row {
    border-top: 1px dotted var(--line);
}
.ps-listings-meta {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
}
.ps-listings-line1 {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    flex-wrap: wrap;
}
.ps-listings-line1 strong {
    color: var(--ink);
    font-weight: 500;
}
.ps-listings-line2 {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
}
.ps-listings-line3 {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
}
.ps-listings-line3 .ps-listings-price {
    color: var(--ink);
}
.ps-listings-line3 .ps-listings-fee {
    color: var(--accent);
}
.ps-listings-sep {
    color: var(--line);
    user-select: none;
}
.ps-listings-label {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
}
.ps-listings-select {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--ink);
    background: transparent;
    border: 1px solid var(--line);
    padding: 2px 6px;
}
.ps-listings-action {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
}
.ps-listings-btn {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink);
    background: transparent;
    border: 1px solid var(--ink);
    padding: 8px 14px;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
}
.ps-listings-btn:hover:not(:disabled) {
    background: var(--ink);
    color: var(--bg);
}
.ps-listings-btn:disabled {
    cursor: not-allowed;
    opacity: 0.5;
}
.ps-listings-txlink {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    text-decoration: underline;
}
.ps-listings-error {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--danger);
    max-width: 220px;
    text-align: right;
}
.ps-listings-sole {
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.5;
    color: var(--muted);
    margin-top: 2px;
    max-width: 460px;
}
.ps-listings-sole-alert {
    color: var(--danger);
}
.ps-listings-steer {
    font-family: var(--mono);
    font-size: 11px;
    color: currentColor;
    background: transparent;
    border: none;
    border-bottom: 1px solid currentColor;
    padding: 0;
    cursor: pointer;
}
@media (max-width: 560px) {
    .ps-listings-row {
        grid-template-columns: 48px 1fr;
        grid-template-rows: auto auto;
    }
    .ps-listings-row:not(:has(.ps-listings-thumb)) {
        grid-template-columns: 1fr;
    }
    .ps-listings-action {
        grid-column: 1 / -1;
        align-items: flex-start;
    }
}
`;
