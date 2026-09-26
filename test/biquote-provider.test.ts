import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    BiquoteProvider,
    normalizeTf,
    tfToInterval,
    parseTicker,
    biquoteBarToOHLCV,
    dedupeSorted,
    aggregate,
    aggregateCalendar,
    type RawBiquoteBar,
} from '../src/data/providers/biquote/BiquoteProvider';
import type { OHLCV } from '../src/core/model/ohlcv';

const MIN = 60_000;

describe('Biquote pure helpers', () => {
    it('normalizeTf maps user aliases to canonical keys', () => {
        expect(normalizeTf('1m')).toBe('1');
        expect(normalizeTf('5m')).toBe('5');
        expect(normalizeTf('15m')).toBe('15');
        expect(normalizeTf('30m')).toBe('30');
        expect(normalizeTf('1h')).toBe('60');
        expect(normalizeTf('4h')).toBe('240');
        expect(normalizeTf('1d')).toBe('D');
        expect(normalizeTf('1w')).toBe('W');
        expect(normalizeTf('1mo')).toBe('M');
        expect(normalizeTf('60')).toBe('60');
        expect(normalizeTf('D')).toBe('D');
    });

    it('tfToInterval maps canonical keys to native Biquote intervals', () => {
        expect(tfToInterval('1')).toBe('1m');
        expect(tfToInterval('5')).toBe('5m');
        expect(tfToInterval('15')).toBe('15m');
        expect(tfToInterval('30')).toBe('30m');
        expect(tfToInterval('60')).toBe('1h');
        expect(tfToInterval('240')).toBe('4h');
        expect(tfToInterval('D')).toBe('1d');
        expect(tfToInterval('W')).toBeNull(); // aggregated from 1d
        expect(tfToInterval('3')).toBeNull(); // aggregated from 1m
    });

    it('parseTicker handles prefixes and delimiters', () => {
        expect(parseTicker('EURUSD')).toBe('EURUSD');
        expect(parseTicker('biquote:EURUSD')).toBe('EURUSD');
        expect(parseTicker('BIQUOTE:btc-usd')).toBe('BTCUSD');
        expect(parseTicker('EUR/USD')).toBe('EURUSD');
        expect(parseTicker('  xauusd  ')).toBe('XAUUSD');
    });

    it('biquoteBarToOHLCV maps ISO openTime to ms and uses tickVolume when volume is 0', () => {
        const raw: RawBiquoteBar = {
            openTime: '2026-09-25T07:00:00Z',
            open: 1.13858,
            high: 1.13885,
            low: 1.13784,
            close: 1.13869,
            volume: 0,
            tickVolume: 3500,
            isOpen: true,
        };
        const mapped = biquoteBarToOHLCV(raw);
        expect(mapped.time).toBe(new Date('2026-09-25T07:00:00Z').getTime());
        expect(mapped.open).toBe(1.13858);
        expect(mapped.high).toBe(1.13885);
        expect(mapped.low).toBe(1.13784);
        expect(mapped.close).toBe(1.13869);
        expect(mapped.volume).toBe(3500);
    });

    it('dedupeSorted sorts by open-time and drops duplicates', () => {
        const b1: OHLCV = { time: 200, open: 2, high: 2, low: 2, close: 2, volume: 10 };
        const b2: OHLCV = { time: 100, open: 1, high: 1, low: 1, close: 1, volume: 10 };
        const b2Dup: OHLCV = { time: 100, open: 1.5, high: 1.5, low: 1.5, close: 1.5, volume: 20 };
        const out = dedupeSorted([b1, b2, b2Dup]);
        expect(out.map((b) => b.time)).toEqual([100, 200]);
        expect(out[0]!.open).toBe(1.5);
    });

    it('aggregate buckets sub-candles into epoch-aligned bars', () => {
        const sub: OHLCV[] = [0, 1, 2, 3, 4, 5].map((m, i) => ({
            time: m * MIN,
            open: 10 + i,
            high: 15 + i,
            low: 5 + i,
            close: 11 + i,
            volume: 100,
        }));
        const out = aggregate(sub, 3 * MIN);
        expect(out.length).toBe(2);
        expect(out[0]!.time).toBe(0);
        expect(out[0]!.open).toBe(10);
        expect(out[0]!.close).toBe(13); // close of minute 2
        expect(out[0]!.volume).toBe(300);
        expect(out[1]!.time).toBe(3 * MIN);
    });

    it('aggregateCalendar folds daily bars into weekly bars (Monday aligned)', () => {
        // 2026-09-21 is a Monday
        const mon = new Date('2026-09-21T00:00:00Z').getTime();
        const tue = new Date('2026-09-22T00:00:00Z').getTime();
        const wed = new Date('2026-09-23T00:00:00Z').getTime();

        const daily: OHLCV[] = [
            { time: mon, open: 100, high: 105, low: 95, close: 102, volume: 50 },
            { time: tue, open: 102, high: 110, low: 101, close: 108, volume: 70 },
            { time: wed, open: 108, high: 109, low: 99, close: 100, volume: 80 },
        ];
        const weekly = aggregateCalendar(daily, 'W');
        expect(weekly.length).toBe(1);
        expect(weekly[0]!.time).toBe(mon);
        expect(weekly[0]!.open).toBe(100);
        expect(weekly[0]!.high).toBe(110);
        expect(weekly[0]!.low).toBe(95);
        expect(weekly[0]!.close).toBe(100);
        expect(weekly[0]!.volume).toBe(200);
    });
});

describe('BiquoteProvider', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('exposes correct provider metadata', () => {
        const provider = new BiquoteProvider();
        const info = provider.info();
        expect(info.name).toBe('biquote');
        expect(info.displayName).toBe('Biquote');
        expect(info.requiresApiKey).toBe(false);
        expect(info.capabilities).toEqual({ enumerate: true, stream: true, symbolInfo: true });
        expect(info.supportedTimeframes).toContain('1');
        expect(info.supportedTimeframes).toContain('60');
        expect(info.supportedTimeframes).toContain('D');
        expect(info.supportedTimeframes).toContain('W');
    });

    it('fetches native candles and converts newest-first API response to ascending bars', async () => {
        const provider = new BiquoteProvider();
        const mockBars: RawBiquoteBar[] = [
            { openTime: '2026-09-25T07:00:00Z', open: 1.138, high: 1.139, low: 1.137, close: 1.1385, volume: 0, tickVolume: 3500, isOpen: true },
            { openTime: '2026-09-25T06:00:00Z', open: 1.137, high: 1.138, low: 1.136, close: 1.1375, volume: 0, tickVolume: 3100, isOpen: false },
            { openTime: '2026-09-25T05:00:00Z', open: 1.136, high: 1.137, low: 1.135, close: 1.1365, volume: 0, tickVolume: 2800, isOpen: false },
        ];

        let requestedUrl = '';
        globalThis.fetch = vi.fn().mockImplementation((url: string) => {
            requestedUrl = url;
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ symbol: 'EURUSD', interval: '1h', bars: mockBars }),
            } as Response);
        });

        const bars = await provider.getBars('EURUSD', '1h', { limit: 100 });
        expect(requestedUrl).toContain('/EURUSD/ohlc?');
        expect(requestedUrl).toContain('interval=1h');
        expect(bars.length).toBe(3);
        // Ascending order: 05:00, 06:00, 07:00
        expect(bars[0]!.time).toBe(new Date('2026-09-25T05:00:00Z').getTime());
        expect(bars[1]!.time).toBe(new Date('2026-09-25T06:00:00Z').getTime());
        expect(bars[2]!.time).toBe(new Date('2026-09-25T07:00:00Z').getTime());
        expect(bars[2]!.close).toBe(1.1385);
    });

    it('passes from and to ISO parameters when date range is specified', async () => {
        const provider = new BiquoteProvider();
        let requestedUrl = '';
        globalThis.fetch = vi.fn().mockImplementation((url: string) => {
            requestedUrl = url;
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({
                    symbol: 'BTCUSD',
                    interval: '1d',
                    bars: [
                        { openTime: '2026-01-02T00:00:00Z', open: 90000, high: 91000, low: 89000, close: 90500, tickVolume: 12000 },
                        { openTime: '2026-01-01T00:00:00Z', open: 88000, high: 90000, low: 87500, close: 89900, tickVolume: 10000 },
                    ],
                }),
            } as Response);
        });

        const from = new Date('2026-01-01T00:00:00Z').getTime();
        const to = new Date('2026-01-05T00:00:00Z').getTime();

        const bars = await provider.getBars('BTCUSD', '1d', { from, to, limit: 100 });
        expect(requestedUrl).toContain('/BTCUSD/ohlc?');
        expect(requestedUrl).toContain('interval=1d');
        expect(requestedUrl).toContain('from=2026-01-01T00%3A00%3A00.000Z');
        expect(requestedUrl).toContain('to=2026-01-05T00%3A00%3A00.000Z');
        expect(bars.length).toBe(2);
        expect(bars[0]!.time).toBe(from);
    });

    it('aggregates non-native timeframes like 3m from 1m sub-candles', async () => {
        const provider = new BiquoteProvider();
        let requestedInterval = '';
        globalThis.fetch = vi.fn().mockImplementation((url: string) => {
            const u = new URL(url);
            requestedInterval = u.searchParams.get('interval') ?? '';
            const t0 = new Date('2026-09-25T00:00:00Z').getTime();
            const bars: RawBiquoteBar[] = [
                { openTime: new Date(t0 + 2 * MIN).toISOString(), open: 12, high: 14, low: 11, close: 13, tickVolume: 10 },
                { openTime: new Date(t0 + 1 * MIN).toISOString(), open: 11, high: 13, low: 10, close: 12, tickVolume: 10 },
                { openTime: new Date(t0).toISOString(), open: 10, high: 12, low: 9, close: 11, tickVolume: 10 },
            ];
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ symbol: 'EURUSD', interval: '1m', bars }),
            } as Response);
        });

        const bars = await provider.getBars('EURUSD', '3m', { limit: 10 });
        expect(requestedInterval).toBe('1m');
        expect(bars.length).toBe(1);
        expect(bars[0]!.open).toBe(10);
        expect(bars[0]!.close).toBe(13);
        expect(bars[0]!.high).toBe(14);
        expect(bars[0]!.low).toBe(9);
    });

    it('returns empty array and logs warning on network error', async () => {
        const provider = new BiquoteProvider();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network offline'));

        const bars = await provider.getBars('EURUSD', '1h', { limit: 10 });
        expect(bars).toEqual([]);
        expect(warnSpy).toHaveBeenCalled();
    });

    it('resolves symbol information for forex and crypto pairs', async () => {
        const provider = new BiquoteProvider();
        globalThis.fetch = vi.fn().mockImplementation((url: string) => {
            if (url.endsWith('/symbols')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve([
                        { name: 'EURUSD', description: 'Euro / US Dollar', type: 'Forex', digits: 5, tickSize: 0.00001 },
                        { name: 'BTCUSD', description: 'Bitcoin / US Dollar', type: 'Crypto', digits: 2, tickSize: 0.01 },
                    ]),
                } as Response);
            }
            return Promise.reject(new Error('Unknown url'));
        });

        const eurInfo = await provider.getSymbolInfo('EURUSD');
        expect(eurInfo).toBeDefined();
        expect(eurInfo?.ticker).toBe('EURUSD');
        expect(eurInfo?.tickerid).toBe('BIQUOTE:EURUSD');
        expect(eurInfo?.type).toBe('forex');
        expect(eurInfo?.mintick).toBe(0.00001);
        expect(eurInfo?.pricescale).toBe(100000);
        expect(eurInfo?.session).toBe('24x5');

        const btcInfo = await provider.getSymbolInfo('BTCUSD');
        expect(btcInfo).toBeDefined();
        expect(btcInfo?.type).toBe('crypto');
        expect(btcInfo?.mintick).toBe(0.01);
        expect(btcInfo?.session).toBe('24x7');
    });

    it('lists symbols from API or falls back to curated catalog', async () => {
        const provider = new BiquoteProvider();
        globalThis.fetch = vi.fn().mockImplementation((url: string) => {
            if (url.endsWith('/symbols')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve([
                        { name: 'EURUSD', description: 'Euro / US Dollar', type: 'Forex', hasData: true },
                        { name: 'INACTIVE', description: 'Inactive', type: 'Stock', hasData: false },
                    ]),
                } as Response);
            }
            return Promise.reject(new Error('Unknown url'));
        });

        const symbols = await provider.listSymbols();
        expect(symbols.some((s) => s.ticker === 'EURUSD')).toBe(true);
        expect(symbols.some((s) => s.ticker === 'INACTIVE')).toBe(false);
    });

    it('subscribes to live bar updates via polling', async () => {
        vi.useFakeTimers();
        try {
            const provider = new BiquoteProvider({ pollIntervalMs: 500 });
            const mockBar: RawBiquoteBar = {
                openTime: '2026-09-25T07:00:00Z',
                open: 1.138,
                high: 1.139,
                low: 1.137,
                close: 1.1385,
                tickVolume: 3500,
                isOpen: true,
            };

            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ symbol: 'EURUSD', interval: '1h', bars: [mockBar] }),
            } as Response);

            const received: OHLCV[] = [];
            const unsubscribe = provider.subscribe('EURUSD', '1h', (b) => {
                received.push(b);
            });

            // Fast forward timers
            await vi.advanceTimersByTimeAsync(600);
            expect(received.length).toBeGreaterThan(0);
            expect(received[0]!.close).toBe(1.1385);

            unsubscribe();
            const countAfterUnsub = received.length;
            await vi.advanceTimersByTimeAsync(1200);
            expect(received.length).toBe(countAfterUnsub);
        } finally {
            vi.useRealTimers();
        }
    });
});
