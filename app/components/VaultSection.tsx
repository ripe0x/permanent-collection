/* Vault section. Short, plain. Sits between the Collection preview and the
   footer to make the irreversibility of vault custody legible without
   leaving the homepage. Once the protocol is live it closes with the wall
   label — chain, date, medium, contract — so the permanence claim points at
   something a visitor can verify. */
import Link from 'next/link';
import {getContractAddresses, isProtocolLive} from '@/lib/config';

export function VaultSection() {
    const live = isProtocolLive();
    const vault = live ? getContractAddresses().punkVault : null;
    return (
        <section className="vault-section" id="vault" aria-label="The vault">
            <div className="wrap">
                <div className="kicker">The vault</div>
                <h2 className="section-title">A vaulted Punk cannot be withdrawn.</h2>
                <p className="vault-copy">
                    No admin withdrawal. No governance withdrawal. No emergency exit. No upgrade path that can reach
                    it.
                </p>
                <p className="vault-copy vault-coda">Permanent traits depend on permanent custody.</p>
                {live && vault && (
                    <p className="vault-wall-label">
                        PunkVault <span className="tnum">{vault}</span> &middot; Ethereum mainnet
                        &middot; live since June 2026 &middot; on-chain SVG, rendered per read
                        &middot; MIT &middot;{' '}
                        <Link href="/docs/introduction/addresses" className="vault-wall-label-link">
                            Verify the contracts &rarr;
                        </Link>
                    </p>
                )}
            </div>
            <style>{styles}</style>
        </section>
    );
}

const styles = `
.vault-copy {
    font-family: var(--sans);
    font-size: 17px;
    line-height: 1.65;
    color: var(--muted);
    max-width: 640px;
    margin-top: 18px;
}
.vault-coda {
    color: var(--ink);
}
.vault-wall-label {
    font-family: var(--mono);
    font-size: 10.5px;
    line-height: 1.9;
    letter-spacing: 0.05em;
    color: var(--muted);
    border-top: 1px solid var(--line);
    margin-top: 30px;
    padding-top: 14px;
    max-width: 640px;
    overflow-wrap: anywhere;
}
.vault-wall-label-link {
    color: var(--ink);
    text-decoration: underline;
    text-underline-offset: 3px;
    white-space: nowrap;
}
.vault-wall-label-link:hover {
    color: var(--muted);
}
`;
