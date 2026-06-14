'use client';

// NFT metadata debug surface. Performs DIRECT contract calls (one
// `eth_call` per row, through the same `/api/rpc` proxy the rest of the app
// uses) and shows both the raw returned URI string and its parsed metadata.
//
// Why raw `client.call` instead of `useReadContract`: the PunkVault /
// renderer compose a full SVG inline, so the metadata `eth_call`s need a
// generous gas budget (the default cap reverts). `client.call({gas})` lets
// us set it; wagmi's read hooks don't.

import {useCallback, useEffect, useState} from 'react';
import {decodeFunctionResult, encodeFunctionData, type Address} from 'viem';
import {usePublicClient} from 'wagmi';
import {getChainId, getContractAddresses, getTokenTicker, isProtocolLive} from '@/lib/config';

// Minimal ABIs — only the four metadata selectors this page exercises.
const erc721MetaAbi = [
    {type: 'function', name: 'tokenURI', stateMutability: 'view', inputs: [{type: 'uint256'}], outputs: [{type: 'string'}]},
    {type: 'function', name: 'contractURI', stateMutability: 'view', inputs: [], outputs: [{type: 'string'}]},
] as const;

const erc20MetaAbi = [
    {type: 'function', name: 'tokenURI', stateMutability: 'view', inputs: [], outputs: [{type: 'string'}]},
    {type: 'function', name: 'contractURI', stateMutability: 'view', inputs: [], outputs: [{type: 'string'}]},
] as const;

// Generous budget — the on-chain renderer composes a full SVG inline and
// exceeds the default eth_call gas cap on most providers.
const CALL_GAS = 600_000_000n;

type ParsedMeta = {
    json: Record<string, unknown> | null;
    image: string | null; // a data URI, renderable directly in <img>
    attributes: {trait_type?: string; value?: unknown}[];
    parseError: string | null;
};

type CallResult = {
    raw: string | null;
    parsed: ParsedMeta | null;
    error: string | null;
    loading: boolean;
};

const EMPTY: CallResult = {raw: null, parsed: null, error: null, loading: true};

/** Decode a `data:application/json[;base64],…` URI to JSON + pull the image
 *  and attributes. Browser-side (atob / decodeURIComponent), not the
 *  server's Buffer path. */
function parseDataUri(uri: string): ParsedMeta {
    const empty: ParsedMeta = {json: null, image: null, attributes: [], parseError: null};
    try {
        const b64 = 'data:application/json;base64,';
        const utf8 = 'data:application/json;utf8,';
        const utf8b = 'data:application/json,';
        let jsonStr: string;
        if (uri.startsWith(b64)) {
            jsonStr = atob(uri.slice(b64.length));
        } else if (uri.startsWith(utf8)) {
            jsonStr = decodeURIComponent(uri.slice(utf8.length));
        } else if (uri.startsWith(utf8b)) {
            jsonStr = decodeURIComponent(uri.slice(utf8b.length));
        } else {
            return {...empty, parseError: 'Not a data:application/json URI'};
        }
        const json = JSON.parse(jsonStr) as Record<string, unknown>;
        const image = typeof json.image === 'string' ? json.image : null;
        const attributes = Array.isArray(json.attributes)
            ? (json.attributes as {trait_type?: string; value?: unknown}[])
            : [];
        return {json, image, attributes, parseError: null};
    } catch (e) {
        return {...empty, parseError: e instanceof Error ? e.message : String(e)};
    }
}

export function NftMetadataDebug() {
    const chainId = getChainId();
    const client = usePublicClient({chainId});
    const live = isProtocolLive();
    const addrs = getContractAddresses();
    const ticker = getTokenTicker();

    const [tokenIdInput, setTokenIdInput] = useState('0');
    // The id actually fetched (only changes on Run), so editing the box
    // doesn't refire calls until the user commits.
    const [activeId, setActiveId] = useState(0);
    const [nonce, setNonce] = useState(0); // bump to refetch the same id

    const [vaultTokenUri, setVaultTokenUri] = useState<CallResult>(EMPTY);
    const [vaultContractUri, setVaultContractUri] = useState<CallResult>(EMPTY);
    const [erc20TokenUri, setErc20TokenUri] = useState<CallResult>(EMPTY);
    const [erc20ContractUri, setErc20ContractUri] = useState<CallResult>(EMPTY);

    const runCall = useCallback(
        async (
            to: Address,
            data: `0x${string}`,
            abi: typeof erc721MetaAbi | typeof erc20MetaAbi,
            functionName: 'tokenURI' | 'contractURI',
            set: (r: CallResult) => void,
        ) => {
            set({...EMPTY, loading: true});
            if (!client) {
                set({raw: null, parsed: null, error: 'No RPC client available.', loading: false});
                return;
            }
            try {
                const res = await client.call({to, data, gas: CALL_GAS});
                if (!res.data || res.data === '0x') {
                    set({raw: null, parsed: null, error: 'Empty return data.', loading: false});
                    return;
                }
                const uri = decodeFunctionResult({abi, functionName, data: res.data}) as string;
                set({raw: uri, parsed: parseDataUri(uri), error: null, loading: false});
            } catch (e) {
                set({
                    raw: null,
                    parsed: null,
                    error: e instanceof Error ? (e as Error).message : String(e),
                    loading: false,
                });
            }
        },
        [client],
    );

    useEffect(() => {
        if (!live) return;
        const idArg = BigInt(activeId);
        void runCall(
            addrs.punkVault,
            encodeFunctionData({abi: erc721MetaAbi, functionName: 'tokenURI', args: [idArg]}),
            erc721MetaAbi,
            'tokenURI',
            setVaultTokenUri,
        );
        void runCall(
            addrs.punkVault,
            encodeFunctionData({abi: erc721MetaAbi, functionName: 'contractURI'}),
            erc721MetaAbi,
            'contractURI',
            setVaultContractUri,
        );
        void runCall(
            addrs.token,
            encodeFunctionData({abi: erc20MetaAbi, functionName: 'tokenURI'}),
            erc20MetaAbi,
            'tokenURI',
            setErc20TokenUri,
        );
        void runCall(
            addrs.token,
            encodeFunctionData({abi: erc20MetaAbi, functionName: 'contractURI'}),
            erc20MetaAbi,
            'contractURI',
            setErc20ContractUri,
        );
        // addrs is stable per render from config; activeId/nonce drive refetch.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeId, nonce, live, runCall]);

    const onRun = (e: React.FormEvent) => {
        e.preventDefault();
        const n = Number.parseInt(tokenIdInput, 10);
        if (Number.isInteger(n) && n >= 0 && n <= 111) {
            if (n === activeId) setNonce((x) => x + 1);
            else setActiveId(n);
        }
    };

    return (
        <div className="nftdbg">
            {!live && (
                <div className="nftdbg-banner">
                    Protocol not live (no token address configured). Calls will revert until launch.
                </div>
            )}

            <form className="nftdbg-controls" onSubmit={onRun}>
                <label htmlFor="nftdbg-id">Token id</label>
                <input
                    id="nftdbg-id"
                    inputMode="numeric"
                    value={tokenIdInput}
                    onChange={(e) => setTokenIdInput(e.target.value)}
                    aria-label="Token id (0–110 Proof, 111 Title)"
                />
                <button type="submit">Run calls</button>
                <div className="nftdbg-quick">
                    <button type="button" onClick={() => setTokenIdInput('0')}>
                        0
                    </button>
                    <button type="button" onClick={() => setTokenIdInput('110')}>
                        110
                    </button>
                    <button type="button" onClick={() => setTokenIdInput('111')}>
                        111 (Title)
                    </button>
                </div>
            </form>

            <div className="nftdbg-targets">
                <div>
                    chain id <span className="mono">{chainId}</span>
                </div>
                <div>
                    PunkVault <span className="mono">{addrs.punkVault}</span>
                </div>
                <div>
                    {ticker} token <span className="mono">{addrs.token}</span>
                </div>
            </div>

            <div className="nftdbg-grid">
                <ResultCard
                    title={`PunkVault.tokenURI(${activeId})`}
                    subtitle={`ERC-721 ${activeId === 111 ? 'Title' : 'Proof'} metadata`}
                    target={addrs.punkVault}
                    result={vaultTokenUri}
                />
                <ResultCard
                    title="PunkVault.contractURI()"
                    subtitle="ERC-721 collection metadata (ERC-7572)"
                    target={addrs.punkVault}
                    result={vaultContractUri}
                />
                <ResultCard
                    title={`${ticker}.tokenURI()`}
                    subtitle="ERC-20 token card metadata"
                    target={addrs.token}
                    result={erc20TokenUri}
                />
                <ResultCard
                    title={`${ticker}.contractURI()`}
                    subtitle="ERC-20 contract metadata (ERC-7572)"
                    target={addrs.token}
                    result={erc20ContractUri}
                />
            </div>

            <style>{styles}</style>
        </div>
    );
}

function ResultCard({
    title,
    subtitle,
    target,
    result,
}: {
    title: string;
    subtitle: string;
    target: Address;
    result: CallResult;
}) {
    return (
        <section className="nftdbg-card">
            <header className="nftdbg-card-head">
                <div className="nftdbg-card-title mono">{title}</div>
                <div className="nftdbg-card-sub">{subtitle}</div>
                <div className="nftdbg-card-target mono">→ {target}</div>
            </header>

            {result.loading ? (
                <div className="nftdbg-status">Calling…</div>
            ) : result.error ? (
                <div className="nftdbg-status nftdbg-error">
                    <strong>Reverted / error</strong>
                    <pre>{result.error}</pre>
                </div>
            ) : (
                <div className="nftdbg-card-body">
                    <div className="nftdbg-img-col">
                        {result.parsed?.image ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                                className="nftdbg-img"
                                src={result.parsed.image}
                                alt="on-chain image"
                            />
                        ) : (
                            <div className="nftdbg-img nftdbg-img-empty">no image field</div>
                        )}
                    </div>

                    <div className="nftdbg-meta-col">
                        {result.parsed?.json && (
                            <dl className="nftdbg-meta">
                                {typeof result.parsed.json.name === 'string' && (
                                    <MetaRow label="name" value={String(result.parsed.json.name)} />
                                )}
                                {typeof result.parsed.json.description === 'string' && (
                                    <MetaRow
                                        label="description"
                                        value={String(result.parsed.json.description)}
                                    />
                                )}
                            </dl>
                        )}

                        {result.parsed && result.parsed.attributes.length > 0 && (
                            <div className="nftdbg-attrs">
                                <div className="nftdbg-attrs-label">attributes</div>
                                <table>
                                    <tbody>
                                        {result.parsed.attributes.map((a, i) => (
                                            <tr key={i}>
                                                <td className="mono">{a.trait_type ?? '—'}</td>
                                                <td>{String(a.value ?? '')}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}

                        {result.parsed?.parseError && (
                            <div className="nftdbg-status nftdbg-error">
                                parse: {result.parsed.parseError}
                            </div>
                        )}

                        <details className="nftdbg-raw">
                            <summary>Raw URI ({result.raw?.length ?? 0} chars)</summary>
                            <pre>{result.raw}</pre>
                        </details>

                        {result.parsed?.json && (
                            <details className="nftdbg-raw">
                                <summary>Parsed JSON</summary>
                                <pre>{JSON.stringify(result.parsed.json, jsonReplacer, 2)}</pre>
                            </details>
                        )}
                    </div>
                </div>
            )}
        </section>
    );
}

function MetaRow({label, value}: {label: string; value: string}) {
    return (
        <div className="nftdbg-meta-row">
            <dt>{label}</dt>
            <dd>{value}</dd>
        </div>
    );
}

// Drop the (often huge) inline image out of the pretty-printed JSON so the
// expandable block stays readable; the image is shown rendered above.
function jsonReplacer(key: string, value: unknown) {
    if (key === 'image' && typeof value === 'string') {
        return `${value.slice(0, 48)}… (${value.length} chars, rendered above)`;
    }
    return value;
}

const styles = `
.nftdbg { display: flex; flex-direction: column; gap: 20px; }
.nftdbg-banner {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--ink);
    background: var(--panel);
    border: 1px solid var(--accent);
    padding: 12px 14px;
}
.nftdbg-controls {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
}
.nftdbg-controls label {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
}
.nftdbg-controls input {
    font-family: var(--mono);
    font-size: 14px;
    width: 90px;
    padding: 8px 10px;
    border: 1px solid var(--line);
    background: var(--bg);
    color: var(--ink);
}
.nftdbg-controls button {
    font-family: var(--mono);
    font-size: 12px;
    padding: 8px 14px;
    border: 1px solid var(--ink);
    background: var(--ink);
    color: var(--bg);
    cursor: pointer;
}
.nftdbg-quick { display: flex; gap: 6px; }
.nftdbg-quick button {
    background: var(--panel);
    color: var(--muted);
    border: 1px solid var(--line);
    padding: 8px 10px;
}
.nftdbg-quick button:hover { color: var(--ink); border-color: var(--ink); }
.nftdbg-targets {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    border: 1px solid var(--line);
    background: var(--panel);
    padding: 12px 14px;
    word-break: break-all;
}
.nftdbg-targets .mono { color: var(--ink); }
.nftdbg-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
    gap: 16px;
}
.nftdbg-card {
    border: 1px solid var(--line);
    background: var(--panel);
    display: flex;
    flex-direction: column;
}
.nftdbg-card-head {
    padding: 14px 16px;
    border-bottom: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.nftdbg-card-title { font-size: 13px; color: var(--ink); word-break: break-all; }
.nftdbg-card-sub { font-family: var(--sans); font-size: 12px; color: var(--muted); }
.nftdbg-card-target { font-size: 10px; color: var(--muted); word-break: break-all; }
.nftdbg-status {
    padding: 16px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
}
.nftdbg-error { color: var(--ink); }
.nftdbg-error strong { color: var(--accent); display: block; margin-bottom: 6px; }
.nftdbg-error pre, .nftdbg-status pre {
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    font-size: 11px;
}
.nftdbg-card-body { padding: 16px; display: flex; flex-direction: column; gap: 16px; }
.nftdbg-img-col { display: flex; }
.nftdbg-img {
    width: 100%;
    max-width: 260px;
    aspect-ratio: 1 / 1;
    object-fit: contain;
    background: #1c1c1c;
    border: 1px solid var(--line);
    image-rendering: pixelated;
}
.nftdbg-img-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    color: #5a5a5a;
    font-family: var(--mono);
    font-size: 11px;
}
.nftdbg-meta-col { display: flex; flex-direction: column; gap: 14px; }
.nftdbg-meta { margin: 0; display: flex; flex-direction: column; gap: 8px; }
.nftdbg-meta-row { display: flex; flex-direction: column; gap: 2px; }
.nftdbg-meta-row dt {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
}
.nftdbg-meta-row dd { margin: 0; font-family: var(--sans); font-size: 13px; color: var(--ink); }
.nftdbg-attrs-label {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 6px;
}
.nftdbg-attrs table { width: 100%; border-collapse: collapse; }
.nftdbg-attrs td {
    font-family: var(--sans);
    font-size: 12px;
    color: var(--ink);
    padding: 4px 8px;
    border: 1px solid var(--line);
}
.nftdbg-attrs td.mono { font-family: var(--mono); color: var(--muted); white-space: nowrap; }
.nftdbg-raw summary {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    cursor: pointer;
}
.nftdbg-raw summary:hover { color: var(--ink); }
.nftdbg-raw pre {
    margin: 8px 0 0;
    padding: 10px;
    background: var(--bg);
    border: 1px solid var(--line);
    font-family: var(--mono);
    font-size: 10px;
    line-height: 1.5;
    color: var(--muted);
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 240px;
    overflow: auto;
}
.mono { font-family: var(--mono); }
`;
