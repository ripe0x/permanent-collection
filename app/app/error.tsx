'use client';

import Link from 'next/link';
import {useEffect} from 'react';

/** Page-level error boundary. The brief: any stuck state resolves to a
 *  plain, in-voice notice with a retry and an explorer link as the source
 *  of truth. */
export default function Error({error, reset}: {error: Error & {digest?: string}; reset: () => void}) {
    useEffect(() => {
        console.error('[page error]', error);
    }, [error]);

    return (
        <section
            style={{
                padding: 'clamp(80px, 14vh, 180px) var(--pad)',
                maxWidth: 'var(--max-wide)',
                margin: '0 auto',
            }}
        >
            <div
                style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 11,
                    letterSpacing: '0.16em',
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                    marginBottom: 24,
                }}
            >
                Something went wrong
            </div>
            <h1
                style={{
                    fontFamily: 'var(--serif)',
                    fontSize: 'clamp(34px, 5vw, 64px)',
                    lineHeight: 1.0,
                    letterSpacing: '-0.04em',
                    fontWeight: 500,
                    marginBottom: 18,
                }}
            >
                The page failed to load live state.
            </h1>
            <p style={{fontFamily: 'var(--sans)', color: 'var(--muted)', maxWidth: 560, lineHeight: 1.65}}>
                The contracts are still the source of truth. You can verify state directly on a block explorer; the
                site will retry on its own, or you can.
            </p>
            <div style={{display: 'flex', gap: 14, marginTop: 28, flexWrap: 'wrap'}}>
                <button className="primary" onClick={reset}>
                    Try again
                </button>
                <Link className="secondary" href="/docs/introduction/addresses">
                    View contracts
                </Link>
            </div>
        </section>
    );
}
