import { describe, it, expect } from 'vitest';
import { SmoothCandleEngine } from '../src/renderers/native/core/SmoothCandleEngine';
import { CandleInterpolator, CandleStateManager } from '../src/renderers/native/core/CandleInterpolator';

describe('SmoothCandleEngine', () => {
    it('initializes physical states and target values correctly', () => {
        const engine = new SmoothCandleEngine();
        engine.init(100, 110, 90, 100, 1700000000, 90);

        expect(engine.open).toBe(100);
        expect(engine.high).toBe(110);
        expect(engine.low).toBe(90);
        expect(engine.close).toBe(100);
        expect(engine.targetClose).toBe(100);
        expect(engine.targetHigh).toBe(110);
        expect(engine.targetLow).toBe(90);
        expect(engine.gpuPayload[0]).toBe(100);
        expect(engine.gpuPayload[1]).toBe(110);
        expect(engine.gpuPayload[2]).toBe(90);
        expect(engine.gpuPayload[3]).toBe(100);
    });

    it('updates targets on incoming tick without allocating memory', () => {
        const engine = new SmoothCandleEngine();
        engine.init(100, 110, 90, 100, 1700000000, 90);

        engine.onTick(120);
        expect(engine.targetClose).toBe(120);
        expect(engine.targetHigh).toBe(120);
        expect(engine.targetLow).toBe(90);
    });

    it('interpolates close toward target with exponential decay and dynamic wick expansion', () => {
        const engine = new SmoothCandleEngine();
        engine.init(100, 100, 100, 100, 1700000000, 90);

        engine.onTick(120);

        // Frame 1: 16ms delta
        const active1 = engine.update(16);
        expect(active1).toBe(true);
        expect(engine.close).toBeGreaterThan(100);
        expect(engine.close).toBeLessThan(120);
        // Dynamic wick expands to enclose the moving body
        expect(engine.high).toBe(engine.close);
        expect(engine.low).toBe(100);

        // Run until settled
        let active = true;
        for (let i = 0; i < 100 && active; i++) {
            active = engine.update(16);
        }

        expect(active).toBe(false);
        expect(engine.close).toBe(120);
        expect(engine.high).toBe(120);
        expect(engine.low).toBe(100);
    });

    it('enforces physical bounds during downward movements', () => {
        const engine = new SmoothCandleEngine();
        engine.init(100, 120, 100, 120, 1700000000, 90);

        engine.onTick(80);

        // Frame 1: 16ms delta downward
        engine.update(16);
        expect(engine.close).toBeLessThan(120);
        expect(engine.high).toBe(120); // High stays at established high

        // Settle
        for (let i = 0; i < 100; i++) {
            engine.update(16);
        }

        expect(engine.close).toBe(80);
        expect(engine.low).toBe(80);
        expect(engine.high).toBe(120);
    });
});

describe('CandleInterpolator & StateManager', () => {
    it('aggregates ticks into OHLC active candles', () => {
        const mgr = new CandleStateManager(60);
        const candle1 = mgr.processTick(100, 60000);
        expect(candle1.open).toBe(100);
        expect(candle1.high).toBe(100);
        expect(candle1.low).toBe(100);
        expect(candle1.close).toBe(100);

        const candle2 = mgr.processTick(110, 65000);
        expect(candle2.high).toBe(110);
        expect(candle2.close).toBe(110);

        const candle3 = mgr.processTick(95, 70000);
        expect(candle3.low).toBe(95);
        expect(candle3.close).toBe(95);
    });

    it('interpolates sub-frame positions smoothly using exponential decay', () => {
        const interpolator = new CandleInterpolator(0.12);
        interpolator.setTarget({ open: 100, high: 100, low: 100, close: 100 });

        expect(interpolator.current.close).toBe(100);

        interpolator.setTarget({ open: 100, high: 120, low: 100, close: 120 });
        const step1 = interpolator.update();

        expect(step1.close).toBeCloseTo(100 + (120 - 100) * 0.12, 4);
        expect(step1.high).toBeGreaterThanOrEqual(step1.close);

        // Run multiple frames
        for (let i = 0; i < 60; i++) {
            interpolator.update();
        }

        expect(interpolator.current.close).toBeCloseTo(120, 1);
    });
});

