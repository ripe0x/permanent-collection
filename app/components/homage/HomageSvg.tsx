'use client';

import type { Shape } from '@/lib/homage/homageGeom';

// Each nested square is a <rect> whose corner radius animates from 0 (square) to half its
// side — a circle inscribed in that square, which is exactly the renderer's PFP variant.
// So the circle form is derived on the client with no extra fetch; toggling just re-targets
// rx/ry and lets CSS ease it.
const MORPH = 'rx 420ms cubic-bezier(0.22,1,0.36,1), ry 420ms cubic-bezier(0.22,1,0.36,1)';

export function HomageSvg({
    ground,
    rects,
    circle,
    className,
}: {
    ground: string;
    rects: Shape[];
    circle: boolean;
    className?: string;
}) {
    return (
        <svg viewBox="0 0 240 240" xmlns="http://www.w3.org/2000/svg" className={className} preserveAspectRatio="xMidYMid meet">
            <rect width="240" height="240" fill={ground} />
            {rects.map((r, i) => {
                const rad = circle ? r.s / 2 : 0;
                return <rect key={i} x={r.x} y={r.y} width={r.s} height={r.s} fill={r.fill} rx={rad} ry={rad} style={{ transition: MORPH }} />;
            })}
        </svg>
    );
}
