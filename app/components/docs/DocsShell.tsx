'use client';

import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {useCallback, useEffect, useRef, useState} from 'react';
import type {DocsManifest} from '@/lib/docs';

interface SearchEntry {
    path: string;
    page: string;
    heading: string;
    anchor: string;
    text: string;
}

interface SearchHit {
    entry: SearchEntry;
    score: number;
}

function searchCorpus(corpus: SearchEntry[], query: string): SearchEntry[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const hits: SearchHit[] = [];
    for (const entry of corpus) {
        const heading = entry.heading.toLowerCase();
        const page = entry.page.toLowerCase();
        const text = entry.text.toLowerCase();
        let score = 0;
        let miss = false;
        for (const t of terms) {
            if (heading.includes(t)) score += heading === t ? 12 : heading.startsWith(t) ? 8 : 5;
            else if (page.includes(t)) score += 3;
            else if (text.includes(t)) score += 1;
            else {
                miss = true;
                break;
            }
        }
        if (!miss) hits.push({entry, score});
    }
    hits.sort((a, b) => b.score - a.score);
    // One result per (path, anchor).
    const seen = new Set<string>();
    const out: SearchEntry[] = [];
    for (const h of hits) {
        const key = `${h.entry.path}#${h.entry.anchor}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(h.entry);
        if (out.length >= 12) break;
    }
    return out;
}

function DocsSearch() {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<SearchEntry[]>([]);
    const [selected, setSelected] = useState(0);
    const [open, setOpen] = useState(false);
    const corpus = useRef<SearchEntry[] | null>(null);
    const boxRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const pathname = usePathname();

    const ensureCorpus = useCallback(async () => {
        if (corpus.current) return;
        try {
            const res = await fetch('/docs-search-index.json');
            corpus.current = (await res.json()) as SearchEntry[];
        } catch {
            corpus.current = [];
        }
    }, []);

    useEffect(() => {
        // Close on navigation.
        setOpen(false);
        setQuery('');
    }, [pathname]);

    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                inputRef.current?.focus();
            }
        }
        function onClick(e: MouseEvent) {
            if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
        }
        window.addEventListener('keydown', onKey);
        window.addEventListener('mousedown', onClick);
        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('mousedown', onClick);
        };
    }, []);

    async function onChange(v: string) {
        setQuery(v);
        await ensureCorpus();
        const hits = searchCorpus(corpus.current ?? [], v);
        setResults(hits);
        setSelected(0);
        setOpen(v.trim().length > 0);
    }

    function hrefOf(e: SearchEntry): string {
        return e.anchor ? `${e.path}#${e.anchor}` : e.path;
    }

    function onKeyDown(e: React.KeyboardEvent) {
        if (!open || results.length === 0) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelected((s) => Math.min(s + 1, results.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelected((s) => Math.max(s - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            window.location.href = hrefOf(results[selected]);
        } else if (e.key === 'Escape') {
            setOpen(false);
        }
    }

    return (
        <div className="docs-search" ref={boxRef}>
            <input
                ref={inputRef}
                type="text"
                placeholder="Search (⌘K)"
                value={query}
                aria-label="Search docs"
                onChange={(e) => void onChange(e.target.value)}
                onFocus={() => {
                    void ensureCorpus();
                    if (query.trim()) setOpen(true);
                }}
                onKeyDown={onKeyDown}
            />
            {open && (
                <div className="docs-search-results" role="listbox">
                    {results.length === 0 && <div className="docs-search-empty">No results</div>}
                    {results.map((r, i) => (
                        <a
                            key={`${r.path}#${r.anchor}`}
                            className={`docs-search-result${i === selected ? ' selected' : ''}`}
                            href={hrefOf(r)}
                        >
                            <span className="docs-search-page">{r.page}</span>
                            <span className="docs-search-heading">{r.heading}</span>
                            <span className="docs-search-text">{r.text}</span>
                        </a>
                    ))}
                </div>
            )}
        </div>
    );
}

export default function DocsShell({manifest, children}: {manifest: DocsManifest; children: React.ReactNode}) {
    const pathname = usePathname();
    const [menuOpen, setMenuOpen] = useState(false);

    useEffect(() => {
        setMenuOpen(false);
    }, [pathname]);

    return (
        <div className="docs-root">
            <header className="docs-topbar">
                <div className="docs-topbar-brand">
                    <Link href="/">PERMANENT COLLECTION</Link>
                    <span className="docs-topbar-sub">Protocol Reference</span>
                </div>
                <div className="docs-topbar-links">
                    <button
                        className="docs-menu-button"
                        type="button"
                        aria-expanded={menuOpen}
                        onClick={() => setMenuOpen((v) => !v)}
                    >
                        {menuOpen ? 'close' : 'menu'}
                    </button>
                    <a href="https://github.com/ripe0x/permanent-collection" target="_blank" rel="noreferrer">
                        github ↗
                    </a>
                </div>
            </header>
            <div className="docs-shell">
                <nav className={`docs-sidebar${menuOpen ? ' open' : ''}`} aria-label="Docs navigation">
                    <DocsSearch />
                    {manifest.sections.map((section) => (
                        <div className="docs-sidebar-section" key={section.id}>
                            <div className="docs-sidebar-section-title">{section.title}</div>
                            {section.items.map((item) => (
                                <Link
                                    key={item.path}
                                    href={item.path}
                                    className={`docs-sidebar-item${pathname === item.path ? ' active' : ''}`}
                                >
                                    {item.title}
                                </Link>
                            ))}
                        </div>
                    ))}
                </nav>
                {children}
            </div>
        </div>
    );
}
