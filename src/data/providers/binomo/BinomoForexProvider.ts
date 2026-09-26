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
                return {
                    time: new Date(item.created_at).getTime(),
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
        let timer: ReturnType<typeof setTimeout> | null = null;
        let animFrameId: number | null = null;

        // Keep track of the active candle state
        let activeTime = 0;
        let currentClose = 0;
        let currentHigh = 0;
        let currentLow = 0;

        // Track last emitted values to avoid unnecessary rendering
        let lastEmittedBarStr = '';

        // Animation config
        const animDuration = 200; // ms
        let animStartTime = 0;
        let startClose = 0;
        let targetClose = 0;
        let startHigh = 0;
        let targetHigh = 0;
        let startLow = 0;
        let targetLow = 0;

        let lastBars: OHLCV[] = [];

        const animate = () => {
            if (stopped) return;
            const now = Date.now();
            const elapsed = now - animStartTime;
            const progress = Math.min(elapsed / animDuration, 1);

            // Cubic easing out for ultra-organic movement
            const t = 1 - Math.pow(1 - progress, 3);

            // Interpolate values
            currentClose = startClose + (targetClose - startClose) * t;
            currentHigh = Math.max(startHigh + (targetHigh - startHigh) * t, currentClose);
            currentLow = Math.min(startLow + (targetLow - startLow) * t, currentClose);

            // Read latest fetched bars
            if (lastBars.length > 0) {
                const clonedBars = lastBars.map((b, i) => {
                    if (i === lastBars.length - 1) {
                        return {
                            ...b,
                            close: currentClose,
                            high: currentHigh,
                            low: currentLow,
                        };
                    }
                    return b;
                });

                // Send the interpolated bars to the chart!
                const latest = clonedBars[clonedBars.length - 1];
                if (latest) {
                    const signature = `${latest.time}-${latest.open}-${latest.high}-${latest.low}-${latest.close}`;
                    if (signature !== lastEmittedBarStr) {
                        lastEmittedBarStr = signature;
                        for (const b of clonedBars) {
                            onBar(b);
                        }
                    }
                }
            }

            if (progress < 1) {
                animFrameId = requestAnimationFrame(animate);
            }
        };

        const poll = async (): Promise<void> => {
            if (stopped) return;
            try {
                const bars = await this.getBars(ticker, timeframe, { limit: 2 });
                if (stopped) return;
                
                if (bars.length > 0) {
                    lastBars = bars;
                    const latest = bars[bars.length - 1];
                    if (latest) {
                        if (latest.time !== activeTime) {
                            // If it's a brand new candle, reset active parameters instantly to avoid sliding from previous candle values
                            activeTime = latest.time;
                            currentClose = latest.close;
                            currentHigh = latest.high;
                            currentLow = latest.low;
                            
                            // Emit immediately to register the new candle open
                            for (const b of bars) {
                                onBar(b);
                            }
                        } else {
                            // Otherwise, smooth-interpolate from the last interpolated position to the new target
                            startClose = currentClose;
                            targetClose = latest.close;

                            startHigh = currentHigh;
                            targetHigh = latest.high;

                            startLow = currentLow;
                            targetLow = latest.low;

                            animStartTime = Date.now();
                            if (animFrameId) cancelAnimationFrame(animFrameId);
                            animFrameId = requestAnimationFrame(animate);
                        }
                    }
                }
            } catch {
                // transient error — keep polling
            }
            if (!stopped) {
                timer = setTimeout(() => void poll(), 250);
            }
        };

        timer = setTimeout(() => void poll(), 250);
        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
            if (animFrameId) cancelAnimationFrame(animFrameId);
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
