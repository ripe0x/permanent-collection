/* Degraded-data strip. Server pages render this when isIndexerDegraded()
   reports a recent indexer failure, so an outage reads as "data temporarily
   incomplete" instead of empty panels that look like a quiet protocol.
   Plain mono, no drama — matches the AsOfBadge register. */

export function IndexerDegradedNotice() {
    return (
        <>
            <div className="wrap">
                <div className="indexer-degraded" role="status">
                    Indexed data is temporarily unavailable. Auction history and lifetime totals
                    may appear incomplete until the indexer recovers; on-chain numbers are
                    unaffected.
                </div>
            </div>
            <style>{styles}</style>
        </>
    );
}

const styles = `
.indexer-degraded {
    margin-top: 12px;
    padding: 10px 14px;
    border: 1px solid var(--accent);
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.5;
    letter-spacing: 0.02em;
    color: var(--accent);
}
`;
