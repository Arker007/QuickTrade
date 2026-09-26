import { describe, it, expect, vi } from 'vitest';
import { EngineOrchestrator } from '../src/core/engine/EngineOrchestrator';
import type { IChartRenderer, VisibleRange } from '../src/core/ports/IChartRenderer';
import type { MarketDataFeed, BarRange } from '../src/core/ports/MarketDataFeed';
import type { OHLCV } from '../src/core/model/ohlcv';
import { DataControl } from '../src/core/DataControl';

const MIN = 60_000;

function createMockRenderer(): IChartRenderer & { _emitViewport: (r: VisibleRange) => void } {
    let viewportCb: ((r: VisibleRange) => void) | null = null;
    return {
        name: 'mock',
        capabilities: { userDrawings: false } as any,
        features: [],
        applyFeature: vi.fn(),
        readFeature: vi.fn(),
        mount: vi.fn(),
        destroy: vi.fn(),
        setBars: vi.fn(),
        updateBar: vi.fn(),
        mountIndicator: vi.fn().mockReturnValue({ id: 'ind1' }),
        updateIndicator: vi.fn(),
        removeIndicator: vi.fn(),
        setIndicatorInputs: vi.fn(),
        setIndicatorVisible: vi.fn(),
        setIndicatorPane: vi.fn(),
        ensurePane: vi.fn(),
        removePane: vi.fn(),
        orderPanes: vi.fn(),
        setPaneCollapsed: vi.fn(),
        setPaneMaximized: vi.fn(),
        onInputChange: vi.fn().mockReturnValue(() => {}),
        onRemoveIndicator: vi.fn().mockReturnValue(() => {}),
        onViewportChange: vi.fn().mockImplementation((cb) => {
            viewportCb = cb;
            return () => { viewportCb = null; };
        }),
        getVisibleRange: vi.fn().mockReturnValue({ from: 100 * MIN, to: 200 * MIN }),
        setVisibleRange: vi.fn(),
        // helper to simulate scrolling back
        _emitViewport: (r: VisibleRange) => {
            if (viewportCb) viewportCb(r);
        },
    } as unknown as IChartRenderer & { _emitViewport: (r: VisibleRange) => void };
}

describe('EngineOrchestrator scroll backfill', () => {
    it('automatically fetches older candles when viewport scrolls near oldest bar', async () => {
        const renderer = createMockRenderer();
        const baseTime = 1000 * MIN;
        const initialBars: OHLCV[] = Array.from({ length: 50 }, (_, i) => ({
            time: baseTime + i * MIN,
            open: 100,
            high: 105,
            low: 95,
            close: 102,
            volume: 10,
        }));

        const olderBars: OHLCV[] = Array.from({ length: 50 }, (_, i) => ({
            time: baseTime - (50 - i) * MIN,
            open: 90,
            high: 95,
            low: 85,
            close: 92,
            volume: 10,
        }));

        const loadRangeMock = vi.fn().mockImplementation((_cfg, range: BarRange) => {
            if (range.to != null && range.to <= baseTime) {
                return Promise.resolve(olderBars);
            }
            return Promise.resolve([]);
        });

        const feed: MarketDataFeed = {
            load: vi.fn().mockResolvedValue(initialBars),
            loadRange: loadRangeMock,
            subscribe: vi.fn().mockReturnValue(() => {}),
        };

        const container = {} as HTMLElement;
        const orchestrator = new EngineOrchestrator(
            container,
            renderer,
            feed,
            [],
            {
                market: { symbol: 'EURUSD', timeframe: '1', bars: 50 },
                live: false,
                theme: {} as any,
                defaultLanguage: 'pine',
            },
            new DataControl(feed),
        );

        await orchestrator.historyComplete();

        // Initially renderer received 50 bars
        expect(renderer.setBars).toHaveBeenCalledWith(initialBars, { preserveView: undefined });

        // Simulate scrolling back so visible left edge is near baseTime
        renderer._emitViewport({ from: baseTime + 10 * MIN, to: baseTime + 40 * MIN });

        // Wait a tick for async loadRange to complete
        await new Promise((r) => setTimeout(r, 20));

        // loadRange was called to fetch older history
        expect(loadRangeMock).toHaveBeenCalled();
        // setBars was called with prepended bars and preserveView: true
        expect(renderer.setBars).toHaveBeenCalledWith(expect.arrayContaining([...olderBars, ...initialBars]), { preserveView: true });
    });
});
