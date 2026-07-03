'use client';

import {useEffect, useState} from 'react';
import type {TocEntry} from '@/lib/docs';

export default function DocsToc({toc}: {toc: TocEntry[]}) {
    const [active, setActive] = useState<string>('');

    useEffect(() => {
        if (toc.length === 0) return;
        const headings = toc
            .map((t) => document.getElementById(t.id))
            .filter((el): el is HTMLElement => el !== null);
        if (headings.length === 0) return;
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        setActive(entry.target.id);
                        return;
                    }
                }
            },
            {rootMargin: '-56px 0px -70% 0px'},
        );
        for (const el of headings) observer.observe(el);
        return () => observer.disconnect();
    }, [toc]);

    if (toc.length < 2) return <div />;

    return (
        <aside className="docs-toc" aria-label="On this page">
            <div className="docs-toc-title">On this page</div>
            {toc.map((t) => (
                <a key={t.id} href={`#${t.id}`} className={`depth-${t.depth}${active === t.id ? ' active' : ''}`}>
                    {t.text}
                </a>
            ))}
        </aside>
    );
}
