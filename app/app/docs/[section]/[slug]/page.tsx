import type {Metadata} from 'next';
import Link from 'next/link';
import {notFound} from 'next/navigation';
import DocsArticle from '@/components/docs/DocsArticle';
import DocsToc from '@/components/docs/DocsToc';
import {getDocPage, getPrevNext} from '@/lib/docs';
import {buildMeta} from '@/lib/meta';

interface Params {
    section: string;
    slug: string;
}

export async function generateMetadata({params}: {params: Promise<Params>}): Promise<Metadata> {
    const {section, slug} = await params;
    const page = getDocPage(section, slug);
    if (!page) return {};
    return buildMeta({
        title: page.title,
        description: page.description,
        path: `/docs/${section}/${slug}`,
    });
}

export default async function DocsPage({params}: {params: Promise<Params>}) {
    const {section, slug} = await params;
    const page = getDocPage(section, slug);
    if (!page) notFound();
    const {prev, next} = getPrevNext(section, slug);

    return (
        <main className="docs-main">
            <article className="docs-article">
                <DocsArticle html={page.html} />
                <nav className="docs-pagenav" aria-label="Previous and next page">
                    {prev && (
                        <Link href={prev.path}>
                            <span className="docs-pagenav-label">Previous</span>
                            <span className="docs-pagenav-title">{prev.title}</span>
                        </Link>
                    )}
                    {next && (
                        <Link href={next.path} className="docs-pagenav-next">
                            <span className="docs-pagenav-label">Next</span>
                            <span className="docs-pagenav-title">{next.title}</span>
                        </Link>
                    )}
                </nav>
            </article>
            <DocsToc toc={page.toc} />
        </main>
    );
}
