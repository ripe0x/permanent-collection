/* Vault section. Short, plain. Sits between the Collection preview and the
   footer to make the irreversibility of vault custody legible without
   leaving the homepage. */
export function VaultSection() {
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
`;
