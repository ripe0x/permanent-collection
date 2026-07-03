'use client';

import {useCallback} from 'react';

/**
 * Renders the pre-generated page HTML and wires up the copy buttons the
 * generator embedded next to each code block. Content is produced by
 * scripts/generate-docs.ts from repo-controlled markdown, so injecting it
 * as HTML is safe.
 */
export default function DocsArticle({html}: {html: string}) {
    const onClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
        const target = e.target as HTMLElement;
        if (!target.classList.contains('doc-copy')) return;
        const pre = target.parentElement?.querySelector('pre');
        const code = pre?.textContent ?? '';
        void navigator.clipboard
            .writeText(code)
            .then(() => {
                const original = target.textContent;
                target.textContent = 'copied';
                setTimeout(() => {
                    target.textContent = original;
                }, 1200);
            })
            .catch(() => {
                // Clipboard denied (insecure context) — leave the button as is.
            });
    }, []);

    return (
        // eslint-disable-next-line react/no-danger
        <div onClick={onClick} dangerouslySetInnerHTML={{__html: html}} />
    );
}
