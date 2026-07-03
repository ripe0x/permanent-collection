import type {Metadata} from 'next';
import DocsShell from '@/components/docs/DocsShell';
import {docsManifest} from '@/lib/docs';
import {buildMeta} from '@/lib/meta';
import './docs.css';

export const metadata: Metadata = buildMeta({
    title: 'Protocol Reference',
    description: 'API-style reference for every PERMANENT COLLECTION contract: functions, events, errors, access control, and integration guides.',
    path: '/docs',
});

export default function DocsLayout({children}: {children: React.ReactNode}) {
    return <DocsShell manifest={docsManifest}>{children}</DocsShell>;
}
