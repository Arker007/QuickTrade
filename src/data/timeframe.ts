/** Named non-minute resolutions → ms. `M` is treated as a 30-day month (bucketing only). */
const NAMED_TF_MS: Record<string, number> = { D: 86_400_000, W: 604_800_000, M: 2_592_000_000, Y: 31_536_000_000 };

/**
 * Bar duration in ms for a Vela timeframe: a bare number is **minutes** (Pine
 * resolution — `60` = 1h, `240` = 4h), `D`/`W`/`M`/`Y` are the named periods, and the
 * `15m`/`4h`/`1d`/`1w`/`3M`/`1y`/`10s` aliases are also accepted. Falls back to 1h for anything unparsed.
 */
export function timeframeToMs(timeframe: string): number {
    const tf = timeframe.trim();
    if (NAMED_TF_MS[tf]) return NAMED_TF_MS[tf];
    const m = /^(\d+)\s*(s|m|min|h|d|w|mo|m|y)?$/i.exec(tf);
    if (m) {
        const n = parseInt(m[1]!, 10);
        const rawUnit = m[2] ?? '';
        if (rawUnit === 'M' || rawUnit.toLowerCase() === 'mo') return n * 2_592_000_000;
        if (rawUnit.toLowerCase() === 'y') return n * 31_536_000_000;
        const unit = rawUnit.toLowerCase();
        const mult = unit === 's' ? 1_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : unit === 'w' ? 604_800_000 : 60_000;
        return n * mult;
    }
    return 3_600_000;
}
