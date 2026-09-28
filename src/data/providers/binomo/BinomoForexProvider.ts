import type { OHLCV } from '../../../core/model/ohlcv';
import type { BarRange, SymbolInfo } from '../../../core/ports/MarketDataFeed';
import type { DataProvider, ProviderInfo, SymbolDescriptor } from '../../../core/ports/DataProvider';
import type { Unsubscribe } from '../../../core/util/types';
import { timeframeToMs } from '../../timeframe';

const CURRENCY_NAMES: Record<string, string> = {
    USD: 'US Dollar',
    EUR: 'Euro',
    GBP: 'British Pound',
    JPY: 'Japanese Yen',
    AUD: 'Australian Dollar',
    CAD: 'Canadian Dollar',
    CHF: 'Swiss Franc',
    NZD: 'New Zealand Dollar',
    NOK: 'Norwegian Krone',
    DKK: 'Danish Krone',
    SEK: 'Swedish Krona',
    SGD: 'Singapore Dollar',
    HKD: 'Hong Kong Dollar',
    PLN: 'Polish Zloty',
    TRY: 'Turkish Lira',
    ZAR: 'South African Rand',
    MXN: 'Mexican Peso',
    INR: 'Indian Rupee',
    BRL: 'Brazilian Real',
    CNH: 'Chinese Yuan',
    RUB: 'Russian Ruble',
    BTC: 'Bitcoin',
    ETH: 'Ethereum',
    CRYPTO: 'Crypto IDX',
};

interface ResolvedSymbol {
    apiSymbol: string;
    base: string;
    quote: string;
    description: string;
    type: 'forex' | 'crypto';
    pricescale: number;
    mintick: number;
    session: string;
}

export class BinomoForexProvider implements DataProvider {
    private fetchCache = new Map<string, { promise: Promise<any>; timestamp: number }>();

    private dayCache = new Map<string, Array<{ open: number; high: number; low: number; close: number; created_at: string }>>();

    private async fetchCached(url: string, ttlMs: number): Promise<any> {
        const now = Date.now();
        const cached = this.fetchCache.get(url);
        if (cached && now - cached.timestamp < ttlMs) {
            return cached.promise;
        }

        const promise = fetch(url).then(async (res) => {
            if (!res.ok) {
                this.fetchCache.delete(url); // don't cache errors
                return { data: [] };
            }
            // Sync with backend server clock using the HTTP Date response header
            try {
                const serverDateStr = res.headers.get('Date');
                if (serverDateStr && typeof window !== 'undefined') {
                    const serverMs = new Date(serverDateStr).getTime();
                    if (!isNaN(serverMs)) {
                        (window as any).SERVER_TIME_OFFSET = Date.now() - serverMs;
                    }
                }
            } catch {
                // ignore
            }
            return res.json();
        }).catch((err) => {
            this.fetchCache.delete(url);
            throw err;
        });

        this.fetchCache.set(url, { promise, timestamp: now });
        return promise;
    }

    info(): ProviderInfo {
        return {
            name: 'binomo',
            displayName: 'Binomo',
            requiresApiKey: false,
            supportedTimeframes: ['1', '5', '15', '30', '60', '240', 'D', 'W', 'M'],
            capabilities: { enumerate: true, stream: true, symbolInfo: true },
        };
    }

    private resolveSymbol(ticker: string): ResolvedSymbol {
        let raw = ticker.trim();
        if (raw.toUpperCase().startsWith('BINOMO:')) {
            raw = raw.slice(7).trim();
        }

        const upper = raw.toUpperCase();
        const clean = upper.replace(/[^A-Z0-9]/g, '');

        // 1. Crypto IDX variations
        if (
            upper === 'Z-CRY/IDX' ||
            upper === 'Z-CRY%2FIDX' ||
            upper === 'Z-CRY' ||
            upper === 'CRY/IDX' ||
            upper === 'CRY-IDX' ||
            clean === 'CRYPTOIDX' ||
            clean === 'CRYPTO' ||
            clean === 'ZCRYIDX' ||
            clean === 'ZCRY' ||
            clean === 'CRYIDX' ||
            clean === 'CRY' ||
            upper.includes('CRY/IDX') ||
            upper.includes('CRY%2FIDX') ||
            clean === 'CRYPTOINDEX'
        ) {
            return {
                apiSymbol: 'Z-CRY%2FIDX',
                base: 'CRYPTO',
                quote: 'USD',
                description: 'Crypto IDX (Binomo)',
                type: 'crypto',
                pricescale: 10000000000,
                mintick: 0.0000000001,
                session: '24x7',
            };
        }

        // 2. Bitcoin / Crypto pairs
        if (clean === 'BTCUSD' || clean === 'BITCOIN' || clean === 'BTC') {
            return {
                apiSymbol: 'BTCUSD',
                base: 'BTC',
                quote: 'USD',
                description: 'Bitcoin / US Dollar',
                type: 'crypto',
                pricescale: 10000000000,
                mintick: 0.0000000001,
                session: '24x7',
            };
        }

        // 3. Euro / USD (Binomo's API endpoint is EURO)
        if (clean === 'EURUSD' || clean === 'EURO' || clean === 'EUR' || upper === 'EUR/USD' || upper === 'EUR%2FUSD') {
            return {
                apiSymbol: 'EURO',
                base: 'EUR',
                quote: 'USD',
                description: 'Euro / US Dollar',
                type: 'forex',
                pricescale: 100000,
                mintick: 0.00001,
                session: '24x5',
            };
        }

        // 4. Handle pair with delimiters (e.g. AUD/CAD, AUD-CAD, AUD_CAD, AUD:CAD, AUD%2FCAD)
        let base = '';
        let quote = '';

        if (upper.includes('%2F')) {
            const parts = upper.split('%2F');
            base = parts[0] ?? '';
            quote = parts[1] ?? '';
        } else if (upper.includes('/')) {
            const parts = upper.split('/');
            base = parts[0] ?? '';
            quote = parts[1] ?? '';
        } else if (upper.includes('-')) {
            const parts = upper.split('-');
            base = parts[0] ?? '';
            quote = parts[1] ?? '';
        } else if (upper.includes('_')) {
            const parts = upper.split('_');
            base = parts[0] ?? '';
            quote = parts[1] ?? '';
        } else if (clean.length === 6) {
            base = clean.slice(0, 3);
            quote = clean.slice(3, 6);
        }

        if (base && quote) {
            const baseUpper = base.toUpperCase();
            const quoteUpper = quote.toUpperCase();

            if (baseUpper === 'EUR' && quoteUpper === 'USD') {
                return {
                    apiSymbol: 'EURO',
                    base: 'EUR',
                    quote: 'USD',
                    description: 'Euro / US Dollar',
                    type: 'forex',
                    pricescale: 100000,
                    mintick: 0.00001,
                    session: '24x5',
                };
            }

            const baseName = CURRENCY_NAMES[baseUpper] ?? baseUpper;
            const quoteName = CURRENCY_NAMES[quoteUpper] ?? quoteUpper;
            const isJpy = quoteUpper === 'JPY';
            const isCrypto = baseUpper === 'BTC' || baseUpper === 'ETH' || baseUpper === 'CRYPTO';

            return {
                apiSymbol: `${baseUpper}%2F${quoteUpper}`,
                base: baseUpper,
                quote: quoteUpper,
                description: `${baseName} / ${quoteName}`,
                type: isCrypto ? 'crypto' : 'forex',
                pricescale: isJpy ? 1000 : isCrypto ? 10000000000 : 100000,
                mintick: isJpy ? 0.001 : isCrypto ? 0.0000000001 : 0.00001,
                session: isCrypto ? '24x7' : '24x5',
            };
        }

        // 5. Fallback URL manipulation for custom / raw tickers
        const apiSymbol = raw.includes('/') ? raw.replace(/\//g, '%2F') : encodeURIComponent(raw);
        return {
            apiSymbol,
            base: raw.slice(0, 3).toUpperCase(),
            quote: 'USD',
            description: `${raw} / US Dollar`,
            type: 'forex',
            pricescale: 10000000000,
            mintick: 0.0000000001,
            session: '24x5',
        };
    }

    async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
        try {
            const tfUpper = timeframe.trim().toUpperCase();
            const isWeekly = tfUpper === 'W' || tfUpper === '1W';
            const isMonthly = tfUpper === 'M' || tfUpper === '1M';
            const isDaily = tfUpper === 'D' || tfUpper === '1D';

            // Map timeframe to duration in minutes
            const tfMs = timeframeToMs(timeframe);
            const targetMin = Math.max(1, Math.round(tfMs / 60_000));

            const { apiSymbol, mintick } = this.resolveSymbol(ticker);

            const todayUTC = new Date();
            const todayStr = `${todayUTC.getUTCFullYear()}-${String(todayUTC.getUTCMonth() + 1).padStart(2, '0')}-${String(todayUTC.getUTCDate()).padStart(2, '0')}T00:00:00`;

            const isLivePoll = range.limit != null && range.limit <= 5 && !range.from && !range.to;

            const dates: string[] = [];

            if (isLivePoll) {
                // Short live poll: only today's file is needed
                dates.push(todayStr);
            } else {
                // Determine the date window
                let fromDate: Date;
                let toDate: Date;

                if (range.from && range.to) {
                    fromDate = new Date(range.from);
                    toDate = new Date(range.to);
                    // Cap max window to 730 days to prevent socket exhaustion on wide ranges
                    const maxSpanMs = 730 * 86400000;
                    if (toDate.getTime() - fromDate.getTime() > maxSpanMs) {
                        fromDate = new Date(toDate.getTime() - maxSpanMs);
                    }
                } else if (range.from) {
                    fromDate = new Date(range.from);
                    toDate = new Date();
                    const maxSpanMs = 730 * 86400000;
                    if (toDate.getTime() - fromDate.getTime() > maxSpanMs) {
                        fromDate = new Date(toDate.getTime() - maxSpanMs);
                    }
                } else if (range.to) {
                    toDate = new Date(range.to);
                    // For backfill, fetch a bite-sized chunk (90-180 days) so each HTTP batch
                    // finishes rapidly in ~1-2s and the engine can chain multiple backfills seamlessly
                    const stepDays = isMonthly ? 365 : (isWeekly || isDaily) ? 180 : targetMin <= 5 ? 30 : targetMin <= 60 ? 90 : 180;
                    fromDate = new Date(toDate.getTime() - stepDays * 86400000);
                } else {
                    // Initial load: fetch rich history so back-dated scrolling has full depth
                    toDate = new Date();
                    // Provide 14 days for 1m (~20,000 candles), 30 days for 5m, 60 days for 15m, 90 days for 1h, 180 days for 4h,
                    // 365 days for Daily (1 year), 540 days for Weekly (1.5 years), 730 days for Monthly (2 years)
                    const days = isMonthly ? 730 : isWeekly ? 540 : isDaily ? 365 : targetMin === 1 ? 14 : targetMin <= 5 ? 30 : targetMin <= 15 ? 60 : targetMin <= 60 ? 120 : 180;
                    fromDate = new Date(toDate.getTime() - days * 86400000);
                }

                // Generate daily midnight dates in UTC
                const current = new Date(fromDate);
                current.setUTCHours(0, 0, 0, 0);

                const end = new Date(toDate);
                end.setUTCHours(0, 0, 0, 0);

                while (current <= end) {
                    const year = current.getUTCFullYear();
                    const month = String(current.getUTCMonth() + 1).padStart(2, '0');
                    const day = String(current.getUTCDate()).padStart(2, '0');
                    dates.push(`${year}-${month}-${day}T00:00:00`);
                    current.setUTCDate(current.getUTCDate() + 1);
                }
            }

            // Fetch the daily 1m candles concurrently through our local CORS proxy
            // Uses persistent in-memory caching for historical closed days and batch concurrency of 25
            const fetchDay = async (formattedDate: string) => {
                const isToday = formattedDate === todayStr;
                const cacheKey = `${apiSymbol}:${formattedDate}`;
                if (!isToday) {
                    const existing = this.dayCache.get(cacheKey);
                    if (existing) return existing;
                }

                const url = `/api/binomo/candles/v1/${apiSymbol}/${formattedDate}/60?locale=en`;
                const ttl = isToday ? 500 : 3600000;
                try {
                    const payload = (await this.fetchCached(url, ttl)) as {
                        data?: Array<{ open: number; high: number; low: number; close: number; created_at: string }>;
                    };
                    const data = payload.data ?? [];
                    if (!isToday && data.length > 0) {
                        this.dayCache.set(cacheKey, data);
                    }
                    return data;
                } catch {
                    return [];
                }
            };

            const batchSize = 25;
            const results: Array<Array<{ open: number; high: number; low: number; close: number; created_at: string }>> = [];
            for (let i = 0; i < dates.length; i += batchSize) {
                const batch = dates.slice(i, i + batchSize);
                const batchResults = await Promise.all(batch.map(fetchDay));
                results.push(...batchResults);
            }
            const candles = results.flat();

            // Transform to Vela's canonical Bar format
            const bars: OHLCV[] = candles.map((item: any) => {
                const open = Number(item.open);
                const high = Number(item.high);
                const low = Number(item.low);
                const close = Number(item.close);
                const rawVol = Number(item.volume ?? item.vol ?? item.v ?? item.count ?? item.ticks ?? 0);
                let volume = rawVol;
                if (!volume || volume <= 0) {
                    const rangeTicks = Math.round(Math.abs(high - low) / (mintick || 0.0000000001));
                    const bodyTicks = Math.round(Math.abs(close - open) / (mintick || 0.0000000001));
                    volume = Math.max(10, Math.round((rangeTicks + bodyTicks * 0.5 + 15) * 1.5));
                }
                const closeTime = parseUTCDate(item.created_at);
                // Binomo 60s candles report created_at at candle close (end of the 60s period).
                // Charting conventions require the bar's open time (start of the 1-minute period).
                const time = Math.round(closeTime / 60_000) * 60_000 - 60_000;
                return {
                    time,
                    open,
                    high,
                    low,
                    close,
                    volume,
                };
            });

            // Deduplicate and sort ascending (oldest first)
            const byTime = new Map<number, OHLCV>();
            for (const b of bars) {
                byTime.set(b.time, b);
            }
            let sortedBars = [...byTime.values()].sort((a, b) => a.time - b.time);

            // Filter strictly by range if requested to guarantee accurate timestamps
            if (range.from) {
                const fromMs = new Date(range.from).getTime();
                sortedBars = sortedBars.filter((b) => b.time >= fromMs);
            }
            if (range.to) {
                const toMs = new Date(range.to).getTime();
                sortedBars = sortedBars.filter((b) => b.time <= toMs);
            }

            // Aggregate bars based on timeframe
            let finalBars: OHLCV[];
            if (targetMin === 1) {
                finalBars = sortedBars;
            } else if (isWeekly) {
                finalBars = this.aggregateCalendar(sortedBars, 'W');
            } else if (isMonthly) {
                finalBars = this.aggregateCalendar(sortedBars, 'M');
            } else {
                finalBars = this.aggregateBars(sortedBars, targetMin);
            }

            if (finalBars.length === 0) {
                return [];
            }

            const resultBars = finalBars;

            // For live poll or when strict limit is requested on ranged slice:
            if (isLivePoll && range.limit && resultBars.length > range.limit) {
                return resultBars.slice(-range.limit);
            }
            if (range.from && range.limit && resultBars.length > range.limit) {
                return resultBars.slice(0, range.limit);
            }
            if (range.to && range.limit && resultBars.length > range.limit) {
                return resultBars.slice(-range.limit);
            }

            return resultBars;
        } catch (e) {
            console.warn(`[vela] Binomo: failed to fetch ${ticker} ${timeframe} — ${e instanceof Error ? e.message : String(e)}`);
            return [];
        }
    }

    private aggregateBars(sub: OHLCV[], bucketMin: number): OHLCV[] {
        const bucketMs = bucketMin * 60_000;
        const buckets = new Map<number, OHLCV>();
        for (const b of sub) {
            const key = Math.floor(b.time / bucketMs) * bucketMs;
            const cur = buckets.get(key);
            if (!cur) {
                buckets.set(key, { time: key, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 });
            } else {
                cur.high = Math.max(cur.high, b.high);
                cur.low = Math.min(cur.low, b.low);
                cur.close = b.close;
                cur.volume = (cur.volume || 0) + (b.volume || 0);
            }
        }
        return [...buckets.values()].sort((a, b) => a.time - b.time);
    }

    private aggregateCalendar(sub: OHLCV[], unit: 'W' | 'M'): OHLCV[] {
        const keyFn = unit === 'W' ? weekStartUTC : monthStartUTC;
        const buckets = new Map<number, OHLCV>();
        for (const b of sub) {
            const key = keyFn(b.time);
            const cur = buckets.get(key);
            if (!cur) {
                buckets.set(key, { time: key, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 });
            } else {
                cur.high = Math.max(cur.high, b.high);
                cur.low = Math.min(cur.low, b.low);
                cur.close = b.close;
                cur.volume = (cur.volume || 0) + (b.volume || 0);
            }
        }
        return [...buckets.values()].sort((a, b) => a.time - b.time);
    }

    async getSymbolInfo(ticker: string): Promise<SymbolInfo | undefined> {
        const resolved = this.resolveSymbol(ticker);

        return {
            ticker,
            tickerid: `BINOMO:${ticker}`,
            prefix: 'BINOMO',
            description: resolved.description,
            type: resolved.type,
            basecurrency: resolved.base,
            currency: resolved.quote,
            mintick: resolved.mintick,
            pricescale: resolved.pricescale,
            timezone: 'Etc/UTC',
            session: resolved.session,
        };
    }

    async listSymbols(): Promise<SymbolDescriptor[]> {
        return [
            { ticker: 'EURUSD', description: 'Euro / US Dollar', type: 'forex' },
            { ticker: 'EURGBP', description: 'Euro / British Pound', type: 'forex' },
            { ticker: 'EURJPY', description: 'Euro / Japanese Yen', type: 'forex' },
            { ticker: 'EURCAD', description: 'Euro / Canadian Dollar', type: 'forex' },
            { ticker: 'GBPJPY', description: 'British Pound / Japanese Yen', type: 'forex' },
            { ticker: 'GBPAUD', description: 'British Pound / Australian Dollar', type: 'forex' },
            { ticker: 'USDCHF', description: 'US Dollar / Swiss Franc', type: 'forex' },
            { ticker: 'USDCAD', description: 'US Dollar / Canadian Dollar', type: 'forex' },
            { ticker: 'USDNOK', description: 'US Dollar / Norwegian Krone', type: 'forex' },
            { ticker: 'USDDKK', description: 'US Dollar / Danish Krone', type: 'forex' },
            { ticker: 'AUDUSD', description: 'Australian Dollar / US Dollar', type: 'forex' },
            { ticker: 'AUDCAD', description: 'Australian Dollar / Canadian Dollar', type: 'forex' },
            { ticker: 'AUDJPY', description: 'Australian Dollar / Japanese Yen', type: 'forex' },
            { ticker: 'CADCHF', description: 'Canadian Dollar / Swiss Franc', type: 'forex' },
            { ticker: 'CHFJPY', description: 'Swiss Franc / Japanese Yen', type: 'forex' },
            { ticker: 'NZDUSD', description: 'New Zealand Dollar / US Dollar', type: 'forex' },
            { ticker: 'NZDJPY', description: 'New Zealand Dollar / Japanese Yen', type: 'forex' },
            { ticker: 'CRYPTO_IDX', description: 'Crypto IDX (Binomo)', type: 'crypto' },
            { ticker: 'Z-CRY/IDX', description: 'Crypto IDX (Z-CRY/IDX)', type: 'crypto' },
            { ticker: 'EURO', description: 'Euro / US Dollar (EURO)', type: 'forex' },
            { ticker: 'BTCUSD', description: 'Bitcoin / US Dollar', type: 'crypto' },
        ];
    }

    subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): Unsubscribe {
        let stopped = false;
        let pollingTimer: ReturnType<typeof setTimeout> | null = null;
        let eventSource: EventSource | null = null;

        const resolved = this.resolveSymbol(ticker);
        const topicAsset = resolved.apiSymbol.replace(/%2F/g, '/');
        const tfMs = timeframeToMs(timeframe);

        // Keep track of the active candle state
        let activeTime = 0;
        let currentOpen = 0;
        let currentClose = 0;
        let targetClose = 0;
        let currentHigh = 0;
        let currentLow = 0;
        let currentVolume = 0;

        let lerpRaf: number | null = null;
        let lerpLastTime = 0;
        let velocityClose = 0;
        const isCryptoIdx = resolved.apiSymbol === 'Z-CRY%2FIDX';
        const lerpFactor = isCryptoIdx ? 0.96 : 0.12;

        const lerp = (start: number, end: number, factor: number) => start + (end - start) * factor;

        const stopLerp = () => {
            if (lerpRaf !== null) {
                if (typeof cancelAnimationFrame === 'function') {
                    cancelAnimationFrame(lerpRaf);
                }
                lerpRaf = null;
            }
        };

        let lastEmittedBarStr = '';
        let lastLiveTickTime = 0;

        const emitBar = (bar: OHLCV) => {
            const signature = `${bar.time}-${bar.open}-${bar.high}-${bar.low}-${bar.close}-${bar.volume ?? 0}`;
            if (signature !== lastEmittedBarStr) {
                lastEmittedBarStr = signature;
                onBar(bar);
            }
        };

        const startLerpAnimation = () => {
            if (typeof requestAnimationFrame === 'undefined') {
                currentClose = targetClose;
                emitBar({
                    time: activeTime,
                    open: currentOpen,
                    high: currentHigh,
                    low: currentLow,
                    close: currentClose,
                    volume: currentVolume,
                });
                return;
            }
            if (lerpRaf !== null) return;

            lerpLastTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
            const step = (now: number) => {
                if (stopped || activeTime === 0) {
                    lerpRaf = null;
                    return;
                }

                const dtMs = Math.min(Math.max(1, now - lerpLastTime), 64);
                lerpLastTime = now;

                const diff = targetClose - currentClose;
                if (Math.abs(diff) < 1e-7) {
                    currentClose = targetClose;
                    currentHigh = Math.max(currentHigh, currentClose);
                    currentLow = Math.min(currentLow, currentClose);
                    emitBar({
                        time: activeTime,
                        open: currentOpen,
                        high: currentHigh,
                        low: currentLow,
                        close: currentClose,
                        volume: currentVolume,
                    });
                    lerpRaf = null;
                    return;
                }

                const algo = (typeof window !== 'undefined' && (window as any).BINOMO_INTERPOLATION_ALGO) || 'decay';

                if (algo === 'spring') {
                    const stiffness = 0.08;
                    const damping = 0.72;
                    const frameRatio = dtMs / 16.667;
                    const force = diff * stiffness;
                    velocityClose = (velocityClose + force * frameRatio) * Math.pow(damping, frameRatio);
                    currentClose += velocityClose * frameRatio;
                } else if (algo === 'step') {
                    currentClose = targetClose;
                    velocityClose = 0;
                } else {
                    // Binomo's exact frame-rate independent LERP calculation
                    const frameRatio = dtMs / 16.667;
                    const effectiveFactor = 1 - Math.pow(1 - lerpFactor, frameRatio);
                    currentClose = lerp(currentClose, targetClose, effectiveFactor);
                    velocityClose = 0;
                }

                currentHigh = Math.max(currentHigh, currentClose);
                currentLow = Math.min(currentLow, currentClose);

                emitBar({
                    time: activeTime,
                    open: currentOpen,
                    high: currentHigh,
                    low: currentLow,
                    close: currentClose,
                    volume: currentVolume,
                });

                lerpRaf = requestAnimationFrame(step);
            };

            lerpRaf = requestAnimationFrame(step);
        };

        const applyLiveTick = (price: number, tickTime: number, partialCandle?: Partial<OHLCV>) => {
            if (stopped || !price || isNaN(price) || price <= 0) return;
            lastLiveTickTime = Date.now();

            const currentLocalBarOpen = Math.floor(Date.now() / tfMs) * tfMs;

            let computedBarTime: number;
            if (tickTime > 0 && tickTime % tfMs === 0) {
                // Exact period boundary timestamp (e.g. 10:35:00.000 for 60s bar) from a closed candle created_at
                computedBarTime = tickTime - tfMs;
            } else if (tickTime > 0) {
                // Intra-period live tick timestamp (e.g. 10:34:08.123 for 60s bar)
                computedBarTime = Math.floor(tickTime / tfMs) * tfMs;
            } else {
                computedBarTime = currentLocalBarOpen;
            }

            // Use computedBarTime directly without capping to the lagging local machine clock to avoid artificial delays
            const barTime = computedBarTime;

            if (barTime > activeTime) {
                // A new bar opened
                stopLerp();
                activeTime = barTime;
                currentOpen = partialCandle?.open ?? price;
                currentHigh = Math.max(partialCandle?.high ?? price, price);
                currentLow = Math.min(partialCandle?.low ?? price, price);
                targetClose = partialCandle?.close ?? price;
                currentClose = targetClose;
                currentVolume = partialCandle?.volume ?? 1;

                emitBar({
                    time: activeTime,
                    open: currentOpen,
                    high: currentHigh,
                    low: currentLow,
                    close: currentClose,
                    volume: currentVolume,
                });
            } else if (barTime === activeTime || activeTime === 0) {
                if (activeTime === 0) activeTime = barTime;
                if (!currentOpen) currentOpen = partialCandle?.open ?? price;
                currentHigh = Math.max(currentHigh || currentOpen, price, partialCandle?.high ?? price);
                currentLow = Math.min(currentLow || currentOpen, price, partialCandle?.low ?? price);
                targetClose = partialCandle?.close ?? price;
                currentClose = targetClose;
                currentVolume = (currentVolume || 0) + (partialCandle?.volume ?? 1);

                emitBar({
                    time: activeTime,
                    open: currentOpen,
                    high: currentHigh,
                    low: currentLow,
                    close: currentClose,
                    volume: currentVolume,
                });

                startLerpAnimation();
            }
        };

        const pollBars = async (): Promise<void> => {
            if (stopped) return;
            try {
                const bars = await this.getBars(ticker, timeframe, { limit: 2 });
                if (stopped || bars.length === 0) return;

                const isReceivingLiveTicks = lastLiveTickTime > 0 && Date.now() - lastLiveTickTime < 30_000;
                const currentLocalBarOpen = Math.floor(Date.now() / tfMs) * tfMs;

                const rawLatest = bars[bars.length - 1]!;
                const latestTime = rawLatest.time;
                const latest = { ...rawLatest, time: latestTime };

                if (latest.time > activeTime && activeTime !== 0 && bars.length >= 2) {
                    const rawPrev = bars[bars.length - 2]!;
                    const prevTime = Math.min(rawPrev.time, activeTime);
                    emitBar({ ...rawPrev, time: prevTime });
                }
                if (latest.time > activeTime) {
                    activeTime = latest.time;
                    currentOpen = latest.open;
                    currentHigh = latest.high;
                    currentLow = latest.low;
                    if (!isReceivingLiveTicks) {
                        targetClose = latest.close;
                        currentClose = latest.close;
                    }
                    currentVolume = latest.volume ?? 0;
                    emitBar({
                        time: activeTime,
                        open: currentOpen,
                        high: currentHigh,
                        low: currentLow,
                        close: currentClose,
                        volume: currentVolume,
                    });
                } else if (latest.time === activeTime) {
                    if (!currentOpen) currentOpen = latest.open;
                    currentHigh = Math.max(currentHigh || latest.high, latest.high);
                    currentLow = Math.min(currentLow || latest.low, latest.low);
                    if (!isReceivingLiveTicks) {
                        targetClose = latest.close;
                        currentClose = latest.close;
                        currentVolume = Math.max(currentVolume || 0, latest.volume ?? 0);
                        emitBar({
                            time: activeTime,
                            open: currentOpen,
                            high: currentHigh,
                            low: currentLow,
                            close: currentClose,
                            volume: currentVolume,
                        });
                    }
                }
            } catch {
                // transient error — continue polling
            }
            if (!stopped) {
                pollingTimer = setTimeout(() => void pollBars(), 500);
            }
        };

        // Start background polling immediately so candle is never paused
        void pollBars();

        // Connect to SSE stream if running in browser
        if (typeof window !== 'undefined' && typeof EventSource !== 'undefined') {
            try {
                // Request backend WS to join the specific asset topic
                void fetch(`/api/binomo/join?asset=${encodeURIComponent(topicAsset)}`).catch(() => {});

                eventSource = new EventSource(`/events?asset=${encodeURIComponent(topicAsset)}`);

                eventSource.onmessage = (e: MessageEvent) => {
                    if (stopped) return;
                    try {
                        const msg = JSON.parse(e.data);
                        if (!msg || typeof msg !== 'object') return;

                        if (msg.event === 'connected' && typeof msg.time === 'number') {
                            if (typeof window !== 'undefined') {
                                (window as any).SERVER_TIME_OFFSET = Date.now() - msg.time;
                            }
                            return;
                        }

                        const topic: string = msg.topic || '';
                        if (topic && topic !== 'connection') {
                            const cleanTopic = topic.replace(/^(asset:|range_stream:|cfd:)/, '');
                            const cleanNorm = cleanTopic.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
                            const targetNorm = topicAsset.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
                            const baseNorm = resolved.base.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

                            const isMatch = cleanNorm === targetNorm || cleanNorm.includes(targetNorm) || targetNorm.includes(cleanNorm) || cleanNorm === baseNorm || cleanNorm.startsWith(baseNorm);
                            if (!isMatch) {
                                return;
                            }
                        }

                        const payload = msg.payload ?? {};
                        let tickPrice: number | null = null;
                        let tickTime = Date.now();
                        let partialCandle: Partial<OHLCV> | undefined = undefined;

                        const parseCreatedAt = (val: any) => {
                            if (!val) return;
                            const ms = parseUTCDate(val);
                            if (ms > 0) {
                                tickTime = ms;
                            }
                        };

                        if (typeof payload.rate === 'number') {
                            tickPrice = payload.rate;
                            parseCreatedAt(payload.created_at);
                        } else if (typeof payload.close === 'number') {
                            tickPrice = payload.close;
                            parseCreatedAt(payload.created_at);
                            if (typeof payload.open === 'number') {
                                partialCandle = {
                                    open: payload.open,
                                    high: payload.high ?? payload.close,
                                    low: payload.low ?? payload.close,
                                    close: payload.close,
                                };
                            }
                        } else if (typeof payload.value === 'number') {
                            tickPrice = payload.value;
                            parseCreatedAt(payload.created_at);
                        } else if (typeof payload.price === 'number') {
                            tickPrice = payload.price;
                            parseCreatedAt(payload.created_at);
                        } else if (Array.isArray(payload.data) && payload.data.length > 0) {
                            const last = payload.data[payload.data.length - 1];
                            if (last && typeof last.close === 'number') {
                                tickPrice = last.close;
                                parseCreatedAt(last.created_at ?? payload.created_at);
                                if (typeof last.open === 'number') {
                                    partialCandle = {
                                        open: last.open,
                                        high: last.high ?? last.close,
                                        low: last.low ?? last.close,
                                        close: last.close,
                                    };
                                }
                            } else if (last && typeof last.rate === 'number') {
                                tickPrice = last.rate;
                                parseCreatedAt(last.created_at ?? payload.created_at);
                            }
                        } else if (payload.candle && typeof payload.candle.close === 'number') {
                            tickPrice = payload.candle.close;
                            parseCreatedAt(payload.candle.created_at ?? payload.created_at);
                            if (typeof payload.candle.open === 'number') {
                                partialCandle = {
                                    open: payload.candle.open,
                                    high: payload.candle.high ?? payload.candle.close,
                                    low: payload.candle.low ?? payload.candle.close,
                                    close: payload.candle.close,
                                };
                            }
                        }

                        if (tickPrice !== null && !isNaN(tickPrice) && tickPrice > 0) {
                            applyLiveTick(tickPrice, tickTime, partialCandle);
                        }
                    } catch {
                        // ignore malformed frame
                    }
                };
            } catch {
                // ignore
            }
        }

        return () => {
            stopped = true;
            stopLerp();
            if (pollingTimer) clearTimeout(pollingTimer);
            if (eventSource) {
                try {
                    eventSource.close();
                } catch {
                    // ignore
                }
                eventSource = null;
            }
        };
    }
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

/** Safely parse any date string or number as UTC */
function parseUTCDate(val: any): number {
    if (!val) return 0;
    if (typeof val === 'number') {
        return val < 1e11 ? val * 1000 : val;
    }
    let str = String(val).trim();
    if (!str) return 0;
    if (!str.endsWith('Z') && !str.includes('+') && !/-\d\d:\d\d$/.test(str) && !/GMT|UTC/i.test(str)) {
        str = str.replace(' ', 'T');
        if (!str.includes('T')) {
            str += 'T00:00:00Z';
        } else {
            str += 'Z';
        }
    }
    const ms = new Date(str).getTime();
    return isNaN(ms) ? 0 : ms;
}
