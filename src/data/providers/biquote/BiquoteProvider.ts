import type { OHLCV } from '../../../core/model/ohlcv';
import type { BarRange, SymbolInfo } from '../../../core/ports/MarketDataFeed';
import type { DataProvider, ProviderInfo, SymbolDescriptor } from '../../../core/ports/DataProvider';
import { baseOf, ledgerCryptoIconUrl } from '../../symbol-base';
import type { Unsubscribe } from '../../../core/util/types';

/** Default REST API base endpoint for Biquote. */
export const DEFAULT_REST_BASE = 'https://biquote.io/api';
/** Fallback relative proxy path for Vite dev server / browser environments. */
export const PROXY_REST_BASE = '/api/biquote';

/** Maximum bars per single REST request on Biquote (1–1000). */
export const MAX_BARS_PER_REQ = 1000;

/** Native Biquote intervals supported by /ohlc: 1m, 5m, 15m, 30m, 1h, 4h, 1d. */
export const NATIVE_INTERVALS: Record<string, string> = {
    '1': '1m',
    '5': '5m',
    '15': '15m',
    '30': '30m',
    '60': '1h',
    '240': '4h',
    D: '1d',
};

/** User-facing timeframe aliases mapped to canonical keys. */
export const TF_NORMALIZE: Record<string, string> = {
    '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '45m': '45',
    '1h': '60', '2h': '120', '3h': '180', '4h': '240', '6h': '360', '8h': '480', '12h': '720',
    '1d': 'D', '1w': 'W', '1mo': 'M', '1D': 'D', '1W': 'W', '4H': '240',
    '1H': '60', '2H': '120', '30M': '30', '15M': '15', '5M': '5', '1M': '1',
    D: 'D', W: 'W', M: 'M',
};

/** Native granularities in minutes for sub-candle aggregation. */
const NATIVE_MINUTES = [1, 5, 15, 30, 60, 240];
const MIN_TO_INTERVAL: Record<number, string> = {
    1: '1m', 5: '5m', 15: '15m', 30: '30m', 60: '1h', 240: '4h',
};

export const SUPPORTED_TIMEFRAMES = [
    '1', '3', '5', '15', '30', '45', '60', '120', '180', '240', '360', '480', '720', 'D', 'W', 'M',
];

const MS_PER_DAY = 86_400_000;

/** Raw bar format returned by Biquote /ohlc API. */
export interface RawBiquoteBar {
    openTime: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
    tickVolume?: number;
    isOpen?: boolean;
}

/** Envelope returned by Biquote /ohlc API. */
export interface BiquoteOhlcResponse {
    symbol?: string;
    interval?: string;
    bars?: RawBiquoteBar[];
    error?: string;
    message?: string;
}

/** Symbol entry returned by Biquote /symbols API. */
export interface BiquoteSymbolEntry {
    name: string;
    description?: string;
    exchange?: string;
    type?: string;
    digits?: number;
    tickSize?: number;
    tickValue?: number;
    contractSize?: number;
    currency?: string;
    source?: string;
    isActive?: boolean;
    hasData?: boolean;
}

export interface BiquoteProviderOptions {
    baseUrl?: string;
    pollIntervalMs?: number;
}

/** Normalize a timeframe string to canonical Vela key. */
export function normalizeTf(tf: string): string {
    return TF_NORMALIZE[tf] ?? TF_NORMALIZE[tf.toLowerCase()] ?? tf;
}

/** Get the native Biquote interval string for a canonical timeframe, or null if aggregation needed. */
export function tfToInterval(canonicalTf: string): string | null {
    return NATIVE_INTERVALS[canonicalTf] ?? null;
}

/** Parse and sanitize a Vela symbol string into a Biquote ticker name. */
export function parseTicker(ticker: string): string {
    let t = ticker.trim();
    if (t.toUpperCase().startsWith('BIQUOTE:')) {
        t = t.slice(8).trim();
    }
    // Remove slashes and hyphens (e.g. EUR/USD -> EURUSD, BTC-USD -> BTCUSD)
    t = t.replace(/[\/-]/g, '');
    return t.toUpperCase();
}

/** Map a raw Biquote bar object to neutral Vela OHLCV. */
export function biquoteBarToOHLCV(bar: RawBiquoteBar): OHLCV {
    const time = new Date(bar.openTime).getTime();
    return {
        time,
        open: Number(bar.open),
        high: Number(bar.high),
        low: Number(bar.low),
        close: Number(bar.close),
        volume: Number(bar.volume ?? 0) || Number(bar.tickVolume ?? 0),
    };
}

/** Sort by open-time and drop duplicate open-times (incoming wins) — the bar contract. */
export function dedupeSorted(bars: OHLCV[]): OHLCV[] {
    const byTime = new Map<number, OHLCV>();
    for (const b of bars) byTime.set(b.time, b);
    return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Aggregate ascending sub-candles into `bucketMs` buckets aligned to epoch (intraday timeframes). */
export function aggregate(sub: OHLCV[], bucketMs: number): OHLCV[] {
    return aggregateBy(sub, (t) => Math.floor(t / bucketMs) * bucketMs);
}

/**
 * Aggregate ascending daily candles into calendar weeks (Monday-aligned, UTC) or calendar months
 * (UTC) — Biquote has no native weekly/monthly granularity, so `W`/`M` are folded from `1d`.
 */
export function aggregateCalendar(sub: OHLCV[], unit: 'W' | 'M'): OHLCV[] {
    return aggregateBy(sub, unit === 'W' ? weekStartUTC : monthStartUTC);
}

/** Fold ascending sub-candles into buckets keyed by `keyMs(time)`; bucket time = key. */
function aggregateBy(sub: OHLCV[], keyMs: (timeMs: number) => number): OHLCV[] {
    const buckets = new Map<number, OHLCV>();
    for (const b of sub) {
        const key = keyMs(b.time);
        const cur = buckets.get(key);
        if (!cur) {
            buckets.set(key, { time: key, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 });
        } else {
            cur.high = Math.max(cur.high, b.high);
            cur.low = Math.min(cur.low, b.low);
            cur.close = b.close;
            cur.volume = (cur.volume ?? 0) + (b.volume ?? 0);
        }
    }
    return [...buckets.values()].sort((a, b) => a.time - b.time);
}

/** Start of the Monday-aligned UTC week containing `ms`. */
function weekStartUTC(ms: number): number {
    const d = new Date(ms);
    const sinceMonday = (d.getUTCDay() + 6) % 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday);
}

/** Start of the calendar UTC month containing `ms`. */
function monthStartUTC(ms: number): number {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Largest native sub-timeframe (minutes) that evenly divides `targetMin`, or null. */
function selectSubTf(targetMin: number): number | null {
    return NATIVE_MINUTES.filter((m) => m < targetMin && targetMin % m === 0).sort((a, b) => b - a)[0] ?? null;
}

/** Keep the most-recent `limit` bars when a count was requested. */
function clampLimit(bars: OHLCV[], limit?: number): OHLCV[] {
    return limit != null && bars.length > limit ? bars.slice(-limit) : bars;
}

/** Curated fallback symbols when offline or before symbols catalog is fetched. */
const FALLBACK_SYMBOLS: SymbolDescriptor[] = [
    { ticker: 'EURUSD', description: 'Euro / US Dollar', type: 'forex' },
    { ticker: 'GBPUSD', description: 'British Pound / US Dollar', type: 'forex' },
    { ticker: 'USDJPY', description: 'US Dollar / Japanese Yen', type: 'forex' },
    { ticker: 'AUDUSD', description: 'Australian Dollar / US Dollar', type: 'forex' },
    { ticker: 'USDCAD', description: 'US Dollar / Canadian Dollar', type: 'forex' },
    { ticker: 'USDCHF', description: 'US Dollar / Swiss Franc', type: 'forex' },
    { ticker: 'NZDUSD', description: 'New Zealand Dollar / US Dollar', type: 'forex' },
    { ticker: 'EURGBP', description: 'Euro / British Pound', type: 'forex' },
    { ticker: 'EURJPY', description: 'Euro / Japanese Yen', type: 'forex' },
    { ticker: 'GBPJPY', description: 'British Pound / Japanese Yen', type: 'forex' },
    { ticker: 'BTCUSD', description: 'Bitcoin / US Dollar', type: 'crypto' },
    { ticker: 'ETHUSD', description: 'Ethereum / US Dollar', type: 'crypto' },
    { ticker: 'SOLUSD', description: 'Solana / US Dollar', type: 'crypto' },
    { ticker: 'XAUUSD', description: 'Gold / US Dollar', type: 'forex' },
    { ticker: 'XAGUSD', description: 'Silver / US Dollar', type: 'forex' },
    { ticker: 'US500', description: 'S&P 500 Index', type: 'index' },
];

/**
 * Biquote market-data provider for Vela.
 * Sourced from Yahoo Finance (bootstrap), real-time tick aggregation, and MT5 historical feeds.
 *
 * Supports M1 through D1 native timeframes (1m, 5m, 15m, 30m, 1h, 4h, 1d) with automated
 * intraday and calendar aggregation for 3m, 2h, 6h, 8h, 12h, 1w, and 1M.
 *
 *   import { BiquoteProvider } from '@luxalgo/vela/providers/biquote';
 *   chart.data.registerProvider('biquote', new BiquoteProvider());
 */
export class BiquoteProvider implements DataProvider {
    private readonly baseUrl: string;
    private readonly pollIntervalMs: number;
    private symbolsPromise: Promise<SymbolDescriptor[]> | null = null;
    private symbolMetadata = new Map<string, BiquoteSymbolEntry>();

    constructor(options: BiquoteProviderOptions = {}) {
        this.baseUrl = (options.baseUrl ?? DEFAULT_REST_BASE).replace(/\/+$/, '');
        this.pollIntervalMs = options.pollIntervalMs ?? 1500;
    }

    info(): ProviderInfo {
        return {
            name: 'biquote',
            displayName: 'Biquote',
            requiresApiKey: false,
            supportedTimeframes: SUPPORTED_TIMEFRAMES,
            capabilities: { enumerate: true, stream: true, symbolInfo: true },
        };
    }

    async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
        try {
            const symbol = parseTicker(ticker);
            const tf = normalizeTf(timeframe);

            // 1. Native interval
            const nativeInterval = tfToInterval(tf);
            if (nativeInterval) {
                return dedupeSorted(await this.fetchCandles(symbol, nativeInterval, range));
            }

            // 2. Calendar aggregation: W/M fold from daily candles
            if (tf === 'W' || tf === 'M') {
                const span = tf === 'W' ? 7 * MS_PER_DAY : 31 * MS_PER_DAY;
                const subRange: BarRange = range.from != null
                    ? range
                    : { ...range, limit: range.limit != null ? Math.ceil((range.limit * span) / MS_PER_DAY) + 31 : undefined };
                const sub = await this.fetchCandles(symbol, '1d', subRange);
                return clampLimit(aggregateCalendar(sub, tf), range.limit);
            }

            // 3. Numeric intraday aggregation from a native sub-timeframe
            const targetMin = /^\d+$/.test(tf) ? parseInt(tf, 10) : null;
            const subMin = targetMin != null ? selectSubTf(targetMin) : null;
            if (targetMin == null || subMin == null) {
                console.warn(`[vela] Biquote: timeframe "${timeframe}" is not supported and cannot be aggregated.`);
                return [];
            }
            const ratio = targetMin / subMin;
            const subRange: BarRange = { ...range, limit: range.limit != null ? range.limit * ratio + ratio : undefined };
            const sub = await this.fetchCandles(symbol, MIN_TO_INTERVAL[subMin]!, subRange);
            return clampLimit(aggregate(sub, targetMin * 60_000), range.limit);
        } catch (e) {
            console.warn(`[vela] Biquote: failed to fetch ${ticker} ${timeframe} — ${e instanceof Error ? e.message : String(e)}`);
            return [];
        }
    }

    async getSymbolInfo(ticker: string): Promise<SymbolInfo | undefined> {
        const symbol = parseTicker(ticker);
        // Ensure symbols catalog is triggered if not yet loaded
        if (this.symbolMetadata.size === 0) {
            await this.listSymbols().catch(() => []);
        }

        const meta = this.symbolMetadata.get(symbol);
        const isCrypto = meta?.type?.toLowerCase() === 'crypto' || symbol.includes('BTC') || symbol.includes('ETH') || symbol.includes('SOL');
        const isForex = !isCrypto && (meta?.type?.toLowerCase() === 'forex' || /^[A-Z]{6}$/.test(symbol));
        const isJpy = symbol.endsWith('JPY');

        let mintick = 0.0001;
        if (meta?.tickSize && meta.tickSize > 0) {
            mintick = meta.tickSize;
        } else if (meta?.digits != null && meta.digits > 0) {
            mintick = Math.pow(10, -meta.digits);
        } else if (isJpy) {
            mintick = 0.001;
        } else if (isForex) {
            mintick = 0.00001;
        } else if (isCrypto) {
            mintick = 0.01;
        }

        const base = meta?.currency && symbol.startsWith(meta.currency)
            ? meta.currency
            : symbol.length === 6 && isForex
                ? symbol.slice(0, 3)
                : symbol.replace(/(USD|USDT|EUR|GBP|JPY)$/, '') || symbol;

        const quote = meta?.currency ?? (symbol.length === 6 && isForex ? symbol.slice(3, 6) : 'USD');

        return {
            ticker,
            tickerid: `BIQUOTE:${ticker}`,
            prefix: 'BIQUOTE',
            description: meta?.description || `${base} / ${quote}`,
            type: meta?.type?.toLowerCase() || (isCrypto ? 'crypto' : 'forex'),
            basecurrency: base,
            currency: quote,
            mintick,
            pricescale: Math.round(1 / mintick),
            timezone: 'Etc/UTC',
            session: isForex ? '24x5' : '24x7',
        };
    }

    listSymbols(): Promise<SymbolDescriptor[]> {
        if (!this.symbolsPromise) {
            this.symbolsPromise = this.fetchSymbolsCatalog();
        }
        return this.symbolsPromise;
    }

    resolveSymbolIcon(symbol: SymbolDescriptor): string | undefined {
        const type = symbol.type?.toLowerCase();
        if (type === 'crypto' || symbol.ticker.includes('BTC') || symbol.ticker.includes('ETH')) {
            return ledgerCryptoIconUrl(baseOf(symbol));
        }
        return undefined;
    }

    subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): Unsubscribe {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let lastBarTime = 0;

        const poll = async (): Promise<void> => {
            if (stopped) return;
            try {
                const bars = await this.getBars(ticker, timeframe, { limit: 2 });
                if (stopped || bars.length === 0) return;

                const latest = bars[bars.length - 1]!;
                // If candle rolled forward, emit the closed previous bar first
                if (lastBarTime !== 0 && latest.time > lastBarTime && bars.length >= 2) {
                    onBar(bars[bars.length - 2]!);
                }
                lastBarTime = latest.time;
                onBar(latest);
            } catch {
                // transient error; keep polling
            }
            if (!stopped) {
                timer = setTimeout(() => void poll(), this.pollIntervalMs);
            }
        };

        timer = setTimeout(() => void poll(), this.pollIntervalMs);
        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
        };
    }

    // ── Internals ─────────────────────────────────────────────────────────

    private async fetchCandles(symbol: string, interval: string, range: BarRange): Promise<OHLCV[]> {
        const limit = range.limit ?? 300;

        // If a specific range [from, to] was requested
        if (range.from != null) {
            return this.fetchRange(symbol, interval, range.from, range.to, limit);
        }

        // Otherwise fetch most recent candles, paginating backward if limit exceeds 1000
        return this.fetchRecent(symbol, interval, limit, range.to);
    }

    private async fetchRecent(symbol: string, interval: string, limit: number, toMs?: number): Promise<OHLCV[]> {
        let out: OHLCV[] = [];
        let remaining = limit;
        let cursorTo: string | undefined = toMs != null ? new Date(toMs).toISOString() : undefined;
        let guard = Math.ceil(limit / MAX_BARS_PER_REQ) + 2;

        while (remaining > 0 && guard-- > 0) {
            const batchLimit = Math.min(remaining, MAX_BARS_PER_REQ);
            const chunk = await this.requestOhlcChunk(symbol, interval, batchLimit, undefined, cursorTo);
            if (chunk.length === 0) break;

            out = chunk.concat(out);
            remaining -= chunk.length;
            cursorTo = new Date(chunk[0]!.time - 1).toISOString();

            if (chunk.length < batchLimit) break;
        }

        const sorted = dedupeSorted(out);
        return clampLimit(sorted, limit);
    }

    private async fetchRange(symbol: string, interval: string, fromMs: number, toMs?: number, limit?: number): Promise<OHLCV[]> {
        const fromIso = new Date(fromMs).toISOString();
        const toIso = toMs != null ? new Date(toMs).toISOString() : undefined;
        const requestedLimit = Math.min(limit ?? MAX_BARS_PER_REQ, MAX_BARS_PER_REQ);

        const rows = await this.requestOhlcChunk(symbol, interval, requestedLimit, fromIso, toIso);
        let sorted = dedupeSorted(rows);

        sorted = sorted.filter((b) => b.time >= fromMs && (toMs == null || b.time <= toMs));
        return clampLimit(sorted, limit);
    }

    private async requestOhlcChunk(
        symbol: string,
        interval: string,
        limit: number,
        fromIso?: string,
        toIso?: string,
    ): Promise<OHLCV[]> {
        const endpoint = `${this.baseUrl}/${encodeURIComponent(symbol)}/ohlc`;
        const url = new URL(endpoint, typeof window !== 'undefined' ? window.location.href : 'http://localhost');
        url.searchParams.set('interval', interval);
        url.searchParams.set('limit', String(Math.max(1, Math.min(limit, MAX_BARS_PER_REQ))));
        if (fromIso) url.searchParams.set('from', fromIso);
        if (toIso) url.searchParams.set('to', toIso);

        const payload = (await this.fetchJson(url.toString())) as BiquoteOhlcResponse;
        if (!payload || !Array.isArray(payload.bars)) {
            return [];
        }

        return payload.bars.map(biquoteBarToOHLCV).sort((a, b) => a.time - b.time);
    }

    private async fetchSymbolsCatalog(): Promise<SymbolDescriptor[]> {
        try {
            const url = `${this.baseUrl}/symbols`;
            const data = (await this.fetchJson(url)) as BiquoteSymbolEntry[];
            if (!Array.isArray(data) || data.length === 0) {
                return FALLBACK_SYMBOLS;
            }

            const descriptors: SymbolDescriptor[] = [];
            for (const item of data) {
                if (!item.name) continue;
                this.symbolMetadata.set(item.name.toUpperCase(), item);

                // Include active or data-bearing symbols
                if (item.hasData === false) continue;
                descriptors.push({
                    ticker: item.name,
                    description: item.description || item.name,
                    type: (item.type?.toLowerCase() as 'crypto' | 'forex' | 'stock' | 'index') || 'forex',
                    prefix: item.exchange && item.exchange !== 'FOREX' && item.exchange !== 'crypto' ? item.exchange : undefined,
                });
            }

            return descriptors.length > 0 ? descriptors : FALLBACK_SYMBOLS;
        } catch {
            return FALLBACK_SYMBOLS;
        }
    }

    private async fetchJson(url: string): Promise<unknown> {
        const fetchWithTimeout = async (targetUrl: string, ms = 8000) => {
            const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const timer = controller ? setTimeout(() => controller.abort(), ms) : null;
            try {
                const res = await fetch(targetUrl, {
                    headers: { Accept: 'application/json' },
                    signal: controller?.signal,
                });
                return res;
            } finally {
                if (timer) clearTimeout(timer);
            }
        };

        try {
            const res = await fetchWithTimeout(url);
            if (!res.ok) {
                // If direct fetch fails with 404/CORS/500, try proxy endpoint if in browser
                if (typeof window !== 'undefined' && this.baseUrl === DEFAULT_REST_BASE) {
                    const fallbackUrl = url.replace(DEFAULT_REST_BASE, PROXY_REST_BASE);
                    const fallbackRes = await fetchWithTimeout(fallbackUrl);
                    if (fallbackRes.ok) return fallbackRes.json();
                }
                throw new Error(`HTTP ${res.status}`);
            }
            return res.json();
        } catch (err) {
            // Check fallback proxy if direct failed
            if (typeof window !== 'undefined' && this.baseUrl === DEFAULT_REST_BASE) {
                try {
                    const fallbackUrl = url.replace(DEFAULT_REST_BASE, PROXY_REST_BASE);
                    const fallbackRes = await fetchWithTimeout(fallbackUrl);
                    if (fallbackRes.ok) return fallbackRes.json();
                } catch {
                    // ignore proxy failure and throw original error
                }
            }
            throw err;
        }
    }
}
