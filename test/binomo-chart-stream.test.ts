import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CandleAggregator } from '../src/data/providers/binomo/CandleAggregator';
import { BinomoChartStream, attachStreamToChart } from '../src/data/providers/binomo/BinomoChartStream';

describe('CandleAggregator', () => {
    it('quantizes timestamps correctly to 1-minute period boundaries', () => {
        const aggregator = new CandleAggregator(60); // 60s timeframe
        const ts1 = new Date('2026-09-27T10:00:15.123Z').getTime();
        const expected1 = new Date('2026-09-27T10:00:00.000Z').getTime();

        expect(aggregator.quantizeTimestamp(ts1)).toBe(expected1);

        const ts2 = new Date('2026-09-27T10:05:59.999Z').getTime();
        const expected2 = new Date('2026-09-27T10:05:00.000Z').getTime();

        expect(aggregator.quantizeTimestamp(ts2)).toBe(expected2);
    });

    it('quantizes timestamps correctly for 5-minute timeframes', () => {
        const aggregator = new CandleAggregator(300); // 300s = 5m
        const ts = new Date('2026-09-27T10:04:45.000Z').getTime();
        const expected = new Date('2026-09-27T10:00:00.000Z').getTime();

        expect(aggregator.quantizeTimestamp(ts)).toBe(expected);

        const ts2 = new Date('2026-09-27T10:06:12.000Z').getTime();
        const expected2 = new Date('2026-09-27T10:05:00.000Z').getTime();

        expect(aggregator.quantizeTimestamp(ts2)).toBe(expected2);
    });

    it('creates first active candle on first tick', () => {
        const aggregator = new CandleAggregator(60);
        const appendedHandler = vi.fn();
        aggregator.on('candle:appended', appendedHandler);

        const tickTime = new Date('2026-09-27T12:00:10.000Z').getTime();
        aggregator.processTick({ price: 100.5, timestamp: tickTime });

        expect(aggregator.activeCandle).toBeDefined();
        expect(aggregator.activeCandle?.open).toBe(100.5);
        expect(aggregator.activeCandle?.high).toBe(100.5);
        expect(aggregator.activeCandle?.low).toBe(100.5);
        expect(aggregator.activeCandle?.close).toBe(100.5);
        expect(aggregator.activeCandle?.timestamp).toBe(new Date('2026-09-27T12:00:00.000Z').getTime());
        expect(aggregator.activeCandle?.finalized).toBe(false);

        expect(appendedHandler).toHaveBeenCalledTimes(1);
    });

    it('updates active candle high, low, and close on subsequent ticks in same period', () => {
        const aggregator = new CandleAggregator(60);
        const updateHandler = vi.fn();
        aggregator.on('candle:update', updateHandler);

        const baseTime = new Date('2026-09-27T12:00:00.000Z').getTime();
        aggregator.processTick({ price: 100.0, timestamp: baseTime + 5000 });
        aggregator.processTick({ price: 105.0, timestamp: baseTime + 15000 });
        aggregator.processTick({ price: 98.0, timestamp: baseTime + 30000 });
        aggregator.processTick({ price: 102.0, timestamp: baseTime + 45000 });

        expect(aggregator.activeCandle?.open).toBe(100.0);
        expect(aggregator.activeCandle?.high).toBe(105.0);
        expect(aggregator.activeCandle?.low).toBe(98.0);
        expect(aggregator.activeCandle?.close).toBe(102.0);
        expect(aggregator.activeCandle?.finalized).toBe(false);

        expect(updateHandler).toHaveBeenCalledTimes(3);
    });

    it('finalizes active candle and appends new candle when period boundary is crossed', () => {
        const aggregator = new CandleAggregator(60);
        const finalizedHandler = vi.fn();
        const appendedHandler = vi.fn();

        aggregator.on('candle:finalized', finalizedHandler);
        aggregator.on('candle:appended', appendedHandler);

        const t1 = new Date('2026-09-27T12:00:10.000Z').getTime();
        aggregator.processTick({ price: 100.0, timestamp: t1 });

        const t2 = new Date('2026-09-27T12:01:05.000Z').getTime(); // crossed boundary
        aggregator.processTick({ price: 103.0, timestamp: t2 });

        expect(finalizedHandler).toHaveBeenCalledTimes(1);
        const finalizedCandle = finalizedHandler.mock.calls[0]![0];
        expect(finalizedCandle.timestamp).toBe(new Date('2026-09-27T12:00:00.000Z').getTime());
        expect(finalizedCandle.finalized).toBe(true);

        expect(aggregator.history.length).toBe(1);
        expect(aggregator.activeCandle?.timestamp).toBe(new Date('2026-09-27T12:01:00.000Z').getTime());
        expect(aggregator.activeCandle?.open).toBe(103.0);
        expect(aggregator.activeCandle?.close).toBe(103.0);

        expect(appendedHandler).toHaveBeenCalledTimes(2); // Initial tick + new candle tick
    });

    it('patches historical candle when out-of-order tick arrives within acceptable window', () => {
        const aggregator = new CandleAggregator(60);
        const patchHandler = vi.fn();
        aggregator.on('candle:patch', patchHandler);

        const t1 = new Date('2026-09-27T12:00:10.000Z').getTime();
        aggregator.processTick({ price: 100.0, timestamp: t1 });

        // Advance to 12:01
        const t2 = new Date('2026-09-27T12:01:05.000Z').getTime();
        aggregator.processTick({ price: 102.0, timestamp: t2 });

        // Late tick for 12:00 arrives with higher high
        const lateTick = new Date('2026-09-27T12:00:55.000Z').getTime();
        aggregator.processTick({ price: 110.0, timestamp: lateTick });

        expect(patchHandler).toHaveBeenCalledTimes(1);
        expect(aggregator.history[0]?.high).toBe(110.0);
    });

    it('seeds history from REST data properly', () => {
        const aggregator = new CandleAggregator(60);
        const historyLoadedHandler = vi.fn();
        aggregator.on('history:loaded', historyLoadedHandler);

        const mockBars = [
            { time: 1000000000000, open: 10, high: 12, low: 9, close: 11, volume: 100 },
            { time: 1000000060000, open: 11, high: 13, low: 10, close: 12, volume: 150 },
        ];

        aggregator.seedHistory(mockBars);

        expect(historyLoadedHandler).toHaveBeenCalledTimes(1);
        const series = aggregator.getFullSeries();
        expect(series.length).toBe(2);
        expect(series[0]?.open).toBe(10);
        expect(series[1]?.close).toBe(12);
    });
});

describe('BinomoChartStream', () => {
    let mockFetch: any;

    beforeEach(() => {
        mockFetch = vi.fn().mockImplementation((url: string) => {
            return Promise.resolve({
                ok: true,
                json: () =>
                    Promise.resolve({
                        data: [
                            { open: 1.1, high: 1.12, low: 1.09, close: 1.11, created_at: '2026-09-27T10:01:00.000Z' },
                            { open: 1.11, high: 1.13, low: 1.1, close: 1.12, created_at: '2026-09-27T10:02:00.000Z' },
                        ],
                    }),
            });
        });
    });

    it('queues ticks during bootstrapping and drains queue after REST fetch', async () => {
        const stream = new BinomoChartStream({
            symbol: 'EURUSD',
            timeframeSeconds: 60,
            customFetch: mockFetch,
        });

        // Simulate incoming WebSocket message while bootstrapping
        stream.handleMessage(
            JSON.stringify({
                topic: 'range_stream:EURO',
                event: 'rate',
                payload: { rate: 1.15, created_at: '2026-09-27T10:02:30.000Z' },
            }),
        );

        expect(stream.isBootstrapping).toBe(true);

        await stream.start();

        expect(stream.isBootstrapping).toBe(false);
        expect(stream.status).toBe('CONNECTED');

        const series = stream.aggregator.getFullSeries();
        expect(series.length).toBeGreaterThan(0);

        stream.stop();
    });

    it('handles Phoenix WebSocket frame payloads correctly', () => {
        const stream = new BinomoChartStream({
            symbol: 'Z-CRY/IDX',
            timeframeSeconds: 60,
            customFetch: mockFetch,
        });

        stream.isBootstrapping = false;

        const updateFn = vi.fn();
        stream.on('candle:update', updateFn);
        const appendFn = vi.fn();
        stream.on('candle:appended', appendFn);

        // Frame with payload.rate
        stream.handleMessage(
            JSON.stringify({
                topic: 'range_stream:Z-CRY/IDX',
                event: 'rates',
                payload: { rate: 7500.0, created_at: '2026-09-27T11:00:10.000Z' },
            }),
        );

        expect(appendFn).toHaveBeenCalledTimes(1);

        // Higher tick in same minute
        stream.handleMessage(
            JSON.stringify({
                topic: 'range_stream:Z-CRY/IDX',
                event: 'rates',
                payload: { rate: 7520.0, created_at: '2026-09-27T11:00:20.000Z' },
            }),
        );

        expect(updateFn).toHaveBeenCalledTimes(1);
        expect(stream.aggregator.activeCandle?.high).toBe(7520.0);

        stream.stop();
    });

    it('attaches stream to chart renderer properly', () => {
        const stream = new BinomoChartStream({
            symbol: 'EURUSD',
            timeframeSeconds: 60,
            customFetch: mockFetch,
        });

        const setData = vi.fn();
        const update = vi.fn();

        attachStreamToChart(stream, { setData, update });

        stream.aggregator.emit('history:loaded', [{ timestamp: 1000, open: 1, high: 2, low: 1, close: 2, volume: 10, finalized: true }]);
        expect(setData).toHaveBeenCalledTimes(1);

        stream.aggregator.emit('candle:update', { timestamp: 2000, open: 2, high: 3, low: 2, close: 2.5, volume: 5, finalized: false });
        expect(update).toHaveBeenCalledTimes(1);

        stream.stop();
    });
});
