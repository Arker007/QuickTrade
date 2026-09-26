import { describe, it, expect } from 'vitest';
import { PineEngine } from '@luxalgo/vela-pinets';
import type { ScriptingEngine, ExecutionRequest, ExecutionHandlers, IndicatorModel, LineLikeSeries } from '../src/plugin';

describe('PineEngine integration via ScriptingEngine port', () => {
    it('implements ScriptingEngine port contracts', async () => {
        const engine: ScriptingEngine = new PineEngine();
        expect(engine.language).toBe('pine');
        expect(engine.capabilities.streaming).toBe(true);
        expect(engine.capabilities.visibleRange).toBe(true);
        expect(engine.capabilities.inputs).toBe(true);

        const source = `//@version=5
indicator("EMA 20", overlay=true)
plot(ta.ema(close, 20), color=color.orange, linewidth=2)`;

        const prep = await engine.prepare(source, 'ema-test');
        expect(prep.language).toBe('pine');
        expect(prep.meta.title).toBe('EMA 20');
        expect(prep.meta.overlay).toBe(true);

        const bars = Array.from({ length: 30 }, (_, i) => ({
            time: 1700000000000 + i * 60000,
            open: 100 + i,
            high: 105 + i,
            low: 95 + i,
            close: 102 + i,
            volume: 1000,
        }));

        let emittedModel: IndicatorModel | null = null;

        await new Promise<void>((resolve, reject) => {
            const req: ExecutionRequest = {
                prepared: prep,
                inputs: {},
                bars,
                market: { symbol: 'BTCUSDT', timeframe: '60' },
                mode: 'static',
                fetchSeries: () => Promise.resolve([]),
            };

            const handlers: ExecutionHandlers = {
                onModel: (m) => {
                    emittedModel = m;
                },
                onDone: () => {
                    resolve();
                },
                onError: (err) => {
                    reject(err);
                },
            };

            const session = engine.execute(req, handlers);
            expect(session).toBeDefined();
            expect(typeof session.stop).toBe('function');
            expect(typeof session.update).toBe('function');
        });

        expect(emittedModel).not.toBeNull();
        expect(emittedModel!.title).toBe('EMA 20');
        expect(emittedModel!.series.length).toBeGreaterThan(0);
        const series = emittedModel!.series[0] as LineLikeSeries;
        expect(series.points.length).toBe(30);
    });
});
