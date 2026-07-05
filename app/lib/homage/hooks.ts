import { useEffect, useState } from 'react';

/// Debounce a rapidly-changing value (id / holder inputs) so reads don't fire per keystroke.
export function useDebounced<T>(value: T, ms = 300): T {
    const [v, setV] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setV(value), ms);
        return () => clearTimeout(t);
    }, [value, ms]);
    return v;
}
