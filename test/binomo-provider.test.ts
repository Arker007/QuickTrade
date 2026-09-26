import { describe, it, expect, vi } from 'vitest';
import { BinomoForexProvider } from '../src/data/providers/binomo/BinomoForexProvider';

describe('BinomoForexProvider back-date candle fetching', () => {
    it('supports standard and higher timeframes', () => {
        const provider = new BinomoForexProvider();
        const info = provider.info();
        expect(info.name).toBe('binomo');
        expect(info.supportedTimeframes).toContain('1');
        expect(info.supportedTimeframes).toContain('60');
        expect(info.supportedTimeframes).toContain('240');
        expect(info.supportedTimeframes).toContain('D');
        expect(info.supportedTimeframes).toContain('W');
        expect(info.supportedTimeframes).toContain('M');
    });

    it('fetches older candles for backfills past 45 days', async () => {
        const provider = new BinomoForexProvider();
        
        // Mock fetch to simulate historical days
        const fakeFetch = vi.fn().mockImplementation((url: string) => {
            // URL format: /api/binomo/candles/v1/EURO/YYYY-MM-DDT00:00:00/60?locale=en
            const match = /EURO\/(\d{4}-\d{2}-\d{2})T/.exec(url);
            const dateStr = match ? match[1] : '2026-01-01';
            const dayBaseMs = new Date(`${dateStr}T00:00:00Z`).getTime();

            // Return 24 hourly candles worth of 1m data (samples)
            const data = [
                { open: 1.1, high: 1.12, low: 1.09, close: 1.11, created_at: new Date(dayBaseMs + 60_000).toISOString() },
                { open: 1.11, high: 1.13, low: 1.1, close: 1.12, created_at: new Date(dayBaseMs + 3600_000).toISOString() },
            ];

            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ data, errors: [], success: true }),
            });
        });

        globalThis.fetch = fakeFetch;

        // Request 80 days ago
        const to = new Date('2026-09-01T00:00:00Z').getTime();
        const from = new Date('2026-06-01T00:00:00Z').getTime(); // 92 days span

        const bars = await provider.getBars('EURUSD', 'D', { from, to, limit: 100 });
        expect(bars.length).toBeGreaterThan(45);
        expect(bars[0]!.time).toBeLessThanOrEqual(new Date('2026-06-02T00:00:00Z').getTime());
    });

    it('fetches deep history on initial load when range is open', async () => {
        const provider = new BinomoForexProvider();

        const fakeFetch = vi.fn().mockImplementation((url: string) => {
            const match = /EURO\/(\d{4}-\d{2}-\d{2})T/.exec(url);
            const dateStr = match ? match[1] : '2026-01-01';
            const dayBaseMs = new Date(`${dateStr}T00:00:00Z`).getTime();

            const data = [
                { open: 1.1, high: 1.12, low: 1.09, close: 1.11, created_at: new Date(dayBaseMs + 60_000).toISOString() },
                { open: 1.11, high: 1.13, low: 1.1, close: 1.12, created_at: new Date(dayBaseMs + 3600_000).toISOString() },
            ];

            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ data, errors: [], success: true }),
            });
        });

        globalThis.fetch = fakeFetch;

        // Default initial load asks for limit: 500 without from/to
        const bars = await provider.getBars('EURUSD', '1', { limit: 500 });
        // Must fetch at least 14 days of data
        expect(fakeFetch.mock.calls.length).toBeGreaterThanOrEqual(14);
        expect(bars.length).toBeGreaterThan(20);
    });

    it('optimizes live polling to single day when limit <= 5', async () => {
        const provider = new BinomoForexProvider();

        const fakeFetch = vi.fn().mockImplementation((url: string) => {
            const match = /EURO\/(\d{4}-\d{2}-\d{2})T/.exec(url);
            const dateStr = match ? match[1] : '2026-01-01';
            const dayBaseMs = new Date(`${dateStr}T00:00:00Z`).getTime();

            const data = [
                { open: 1.1, high: 1.12, low: 1.09, close: 1.11, created_at: new Date(dayBaseMs + 60_000).toISOString() },
                { open: 1.11, high: 1.13, low: 1.1, close: 1.12, created_at: new Date(dayBaseMs + 120_000).toISOString() },
            ];

            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ data, errors: [], success: true }),
            });
        });

        globalThis.fetch = fakeFetch;

        const bars = await provider.getBars('EURUSD', '1', { limit: 2 });
        expect(fakeFetch.mock.calls.length).toBe(1);
        expect(bars.length).toBe(2);
    });

    it('fetches Crypto IDX (Z-CRY/IDX) candles correctly', async () => {
        const provider = new BinomoForexProvider();

        const fakeFetch = vi.fn().mockImplementation((url: string) => {
            expect(url).toContain('Z-CRY%2FIDX');
            const data = [
                { open: 7500.5, high: 7520.0, low: 7490.0, close: 7515.2, created_at: '2026-09-22T00:01:00.000Z' },
                { open: 7515.2, high: 7530.0, low: 7510.0, close: 7525.8, created_at: '2026-09-22T00:02:00.000Z' },
            ];

            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ data, errors: [], success: true }),
            });
        });

        globalThis.fetch = fakeFetch;

        const bars = await provider.getBars('CRYPTO_IDX', '1', { limit: 2 });
        expect(bars.length).toBe(2);
        expect(bars[0]!.close).toBe(7515.2);

        const barsWithSlash = await provider.getBars('Z-CRY/IDX', '1', { limit: 2 });
        expect(barsWithSlash.length).toBe(2);
    });

    it('provides correct symbol info for Crypto IDX and lists symbols', async () => {
        const provider = new BinomoForexProvider();

        const info = await provider.getSymbolInfo('CRYPTO_IDX');
        expect(info).toBeDefined();
        expect(info?.description).toBe('Crypto IDX (Binomo)');
        expect(info?.type).toBe('crypto');
        expect(info?.session).toBe('24x7');
        expect(info?.pricescale).toBe(10000000000);
        expect(info?.mintick).toBe(0.0000000001);

        const symbols = await provider.listSymbols();
        expect(symbols.some((s) => s.ticker === 'CRYPTO_IDX')).toBe(true);
        expect(symbols.some((s) => s.ticker === 'Z-CRY/IDX')).toBe(true);
        expect(symbols.some((s) => s.ticker === 'EURUSD')).toBe(true);
        expect(symbols.some((s) => s.ticker === 'AUDCAD')).toBe(true);
        expect(symbols.some((s) => s.ticker === 'GBPJPY')).toBe(true);
        expect(symbols.some((s) => s.ticker === 'USDNOK')).toBe(true);
        expect(symbols.some((s) => s.ticker === 'NZDUSD')).toBe(true);
    });

    it('handles forex URL manipulation and diverse ticker formats', async () => {
        const provider = new BinomoForexProvider();

        const requestedUrls: string[] = [];
        const fakeFetch = vi.fn().mockImplementation((url: string) => {
            requestedUrls.push(url);
            const data = [
                { open: 1.25, high: 1.26, low: 1.24, close: 1.255, created_at: '2026-09-22T00:01:00.000Z' },
                { open: 1.255, high: 1.27, low: 1.25, close: 1.265, created_at: '2026-09-22T00:02:00.000Z' },
            ];
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ data, errors: [], success: true }),
            });
        });

        globalThis.fetch = fakeFetch;

        // Test 6-letter ticker
        await provider.getBars('AUDCAD', '1', { limit: 2 });
        expect(requestedUrls[requestedUrls.length - 1]).toContain('/AUD%2FCAD/');

        // Test slashed ticker
        const bars = await provider.getBars('GBP/JPY', '1', { limit: 2 });
        expect(requestedUrls[requestedUrls.length - 1]).toContain('/GBP%2FJPY/');
        expect(bars.length).toBeGreaterThan(0);
        expect(bars[0]?.volume).toBeGreaterThan(0);

        // Test prefixed ticker
        await provider.getBars('BINOMO:USD/CHF', '1', { limit: 2 });
        expect(requestedUrls[requestedUrls.length - 1]).toContain('/USD%2FCHF/');

        // Test hyphenated ticker
        await provider.getBars('USD-NOK', '1', { limit: 2 });
        expect(requestedUrls[requestedUrls.length - 1]).toContain('/USD%2FNOK/');

        // Test EURUSD -> EURO
        await provider.getBars('EURUSD', '1', { limit: 2 });
        expect(requestedUrls[requestedUrls.length - 1]).toContain('/EURO/');

        // Test symbol info resolution
        const gbpJpyInfo = await provider.getSymbolInfo('GBPJPY');
        expect(gbpJpyInfo?.basecurrency).toBe('GBP');
        expect(gbpJpyInfo?.currency).toBe('JPY');
        expect(gbpJpyInfo?.pricescale).toBe(1000);
        expect(gbpJpyInfo?.description).toBe('British Pound / Japanese Yen');

        const audCadInfo = await provider.getSymbolInfo('AUD/CAD');
        expect(audCadInfo?.basecurrency).toBe('AUD');
        expect(audCadInfo?.currency).toBe('CAD');
        expect(audCadInfo?.pricescale).toBe(100000);
        expect(audCadInfo?.description).toBe('Australian Dollar / Canadian Dollar');
    });

    it('aggregates weekly candles aligned to Monday and loads deep history for 1W', async () => {
        const provider = new BinomoForexProvider();

        const fakeFetch = vi.fn().mockImplementation((url: string) => {
            const match = /Z-CRY%2FIDX\/(\d{4}-\d{2}-\d{2})T/.exec(url);
            const dateStr = match ? match[1] : '2026-01-01';
            const dayBaseMs = new Date(`${dateStr}T00:00:00Z`).getTime();

            const data = [
                { open: 640.0, high: 645.0, low: 638.0, close: 642.0, created_at: new Date(dayBaseMs + 60_000).toISOString() },
                { open: 642.0, high: 648.0, low: 641.0, close: 644.0, created_at: new Date(dayBaseMs + 3600_000).toISOString() },
            ];

            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ data, errors: [], success: true }),
            });
        });

        globalThis.fetch = fakeFetch;

        const bars = await provider.getBars('CRYPTO_IDX', 'W', { limit: 50 });
        expect(bars.length).toBeGreaterThan(10);
        // Every weekly bar must start on Monday 00:00:00 UTC (day of week 1 in UTC)
        for (const b of bars) {
            const d = new Date(b.time);
            expect(d.getUTCDay()).toBe(1); // Monday
            expect(d.getUTCHours()).toBe(0);
            expect(d.getUTCMinutes()).toBe(0);
        }

        // Test backfill on weekly
        const oldestTime = bars[0]!.time;
        const olderBars = await provider.getBars('CRYPTO_IDX', 'W', { to: oldestTime, limit: 50 });
        expect(olderBars.length).toBeGreaterThan(0);
        expect(olderBars[olderBars.length - 1]!.time).toBeLessThanOrEqual(oldestTime);
    });

    it('does not generate anything when the API returns no candle data', async () => {
        const provider = new BinomoForexProvider();

        // API returns empty data array
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ data: [], errors: [], success: true }),
        });

        const bars = await provider.getBars('EURUSD', '60', { limit: 100 });
        expect(bars).toEqual([]);
    });

    it('does not generate anything when the fetch fails', async () => {
        const provider = new BinomoForexProvider();

        globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network offline'));

        const bars = await provider.getBars('EURUSD', '60', { limit: 100 });
        expect(bars).toEqual([]);
    });
});
