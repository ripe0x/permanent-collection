'use client';

/* Detects a positive increase in a polled bigint and surfaces it as a
 * transient "flash" delta that auto-clears after `clearMs`.
 *
 * Both the header live-bid chip and the /trade `LiveBidStat` use this to
 * pulse a green "+delta" badge whenever the live bid grows. The first
 * defined value only SEEDS the baseline (no flash on initial load — the
 * data landing isn't an increase); subsequent increases flash.
 */

import {useEffect, useRef, useState} from 'react';

/** Returns the most-recent positive increase of `value`, or 0n when there's
 *  nothing to show. Pass `undefined` while the value hasn't loaded yet — the
 *  hook seeds its baseline on the first defined value without flashing. */
export function useIncreaseFlash(value: bigint | undefined, clearMs = 2500): bigint {
    const [delta, setDelta] = useState<bigint>(0n);
    const prevRef = useRef<bigint | undefined>(value);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (value === undefined) return;
        const prev = prevRef.current;
        prevRef.current = value;
        if (prev !== undefined && value > prev) {
            setDelta(value - prev);
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => setDelta(0n), clearMs);
        }
    }, [value, clearMs]);

    // Clear any pending timer on unmount.
    useEffect(
        () => () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        },
        [],
    );

    return delta;
}
