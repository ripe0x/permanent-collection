/**
 * Typed accessors over the generated docs content.
 *
 * `manifest.json` and `content.json` are emitted by `scripts/generate-docs.ts`
 * (run `pnpm generate:docs` at the repo root) and checked in, so the app build
 * needs no filesystem access to docs/reference at request time. The docs pages
 * import from here and stay free of markdown machinery.
 */
import manifestJson from './manifest.json';
import contentJson from './content.json';

export interface TocEntry {
    depth: number;
    text: string;
    id: string;
}

export interface DocPage {
    section: string;
    slug: string;
    title: string;
    description: string;
    html: string;
    toc: TocEntry[];
}

export interface ManifestItem {
    title: string;
    slug: string;
    path: string;
    description: string;
}

export interface ManifestSection {
    id: string;
    title: string;
    items: ManifestItem[];
}

export interface DocsManifest {
    title: string;
    sections: ManifestSection[];
}

export const docsManifest = manifestJson as DocsManifest;

const content = contentJson as Record<string, DocPage>;

export function getDocPage(section: string, slug: string): DocPage | null {
    return content[`${section}/${slug}`] ?? null;
}

function flatItems(): ManifestItem[] {
    return docsManifest.sections.flatMap((s) => s.items);
}

export function getPrevNext(
    section: string,
    slug: string,
): {prev: ManifestItem | null; next: ManifestItem | null} {
    const flat = flatItems();
    const i = flat.findIndex((it) => it.path === `/docs/${section}/${slug}`);
    if (i === -1) return {prev: null, next: null};
    return {
        prev: i > 0 ? flat[i - 1] : null,
        next: i < flat.length - 1 ? flat[i + 1] : null,
    };
}
