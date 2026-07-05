'use client';

import { useEffect, useRef, useState } from 'react';

// Split-flap glyph reel — space first so blanks roll cleanly, then the chars that
// show up in punk traits (letters, digits, #, -, .).
const CHARS = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#-.';
const N = CHARS.length;
const STEP_MS = 28; // time per flap step (lower = faster/smoother)
const SPIN_BASE = 7; // flaps the first character travels before it settles

const idxOf = (c: string) => {
    const i = CHARS.indexOf(c.toUpperCase());
    return i < 0 ? 0 : i;
};

/**
 * Departures-board text: each character rolls forward through the glyph reel to
 * its target, cascading left-to-right; the whole element re-runs whenever
 * `trigger` changes (e.g. the punk id). Monospace keeps the width steady so the
 * roll never reflows the row.
 */
export function Flap({
    value,
    trigger,
    delay = 0,
    className,
}: {
    value: string;
    trigger: number | string;
    delay?: number;
    className?: string;
}) {
    const [text, setText] = useState(value);
    const valueRef = useRef(value);
    valueRef.current = value;

    useEffect(() => {
        const target = valueRef.current;
        const chars = [...target];
        const targetIdx = chars.map(idxOf);
        // start each position a fixed distance behind its target; later positions
        // start further back, so they settle left-to-right.
        const cur = targetIdx.map((ti, i) => (ti - (SPIN_BASE + i) + N * 8) % N);
        const paint = () => setText(chars.map((c, i) => (c === ' ' ? ' ' : CHARS[cur[i]])).join(''));
        paint(); // show the scrambled reel immediately, never flash the answer

        // setInterval (not rAF) so the roll still advances in a backgrounded/hidden tab
        // instead of freezing mid-scramble; it just throttles there.
        let interval: ReturnType<typeof setInterval> | undefined;
        const startTimer = setTimeout(() => {
            interval = setInterval(() => {
                let done = true;
                for (let i = 0; i < cur.length; i++) {
                    if (cur[i] !== targetIdx[i]) {
                        cur[i] = (cur[i] + 1) % N;
                        done = false;
                    }
                }
                if (done) {
                    if (interval) clearInterval(interval);
                    setText(target); // settle on the real (cased) string
                    return;
                }
                paint();
            }, STEP_MS);
        }, delay);

        return () => {
            clearTimeout(startTimer);
            if (interval) clearInterval(interval);
        };
        // Re-roll on trigger (a new punk) OR on value (the meta can arrive a render after the id when
        // rendering locally), so the reel always settles on the current value rather than a stale one.
    }, [trigger, value, delay]);

    return <span className={className}>{text}</span>;
}
