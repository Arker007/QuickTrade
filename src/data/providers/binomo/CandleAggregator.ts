import type { OHLCV } from '../../../core/model/ohlcv';

export type UnixMS = number;

export interface Candle {
    timestamp: UnixMS;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    finalized: boolean;
}

export interface Tick {
    price: number;
    timestamp: UnixMS;
    volume?: number;
}

export interface CandlePatchEvent extends Candle {
    index: number;
}

export type AggregatorEventMap = {
    'candle:update': Candle;
    'candle:finalized': Candle;
    'candle:appended': Candle;
    'candle:patch': CandlePatchEvent;
    'history:loaded': Candle[];
    'status:change': string;
    'error': Error | Event;
    [key: string]: any;
};

type EventListener<T> = (payload: T) => void;

export class EventEmitter {
    private listeners = new Map<string, Set<EventListener<any>>>();

    on<K extends keyof AggregatorEventMap>(event: K, fn: EventListener<AggregatorEventMap[K]>): () => void;
    on(event: string, fn: EventListener<any>): () => void {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        set.add(fn);
        return () => this.off(event, fn);
    }

    off<K extends keyof AggregatorEventMap>(event: K, fn: EventListener<AggregatorEventMap[K]>): void;
    off(event: string, fn: EventListener<any>): void {
        const set = this.listeners.get(event);
        if (set) {
            set.delete(fn);
        }
    }

    emit<K extends keyof AggregatorEventMap>(event: K, payload: AggregatorEventMap[K]): void;
    emit(event: string, payload: any): void {
        const set = this.listeners.get(event);
        if (set) {
            for (const fn of set) {
                try {
                    fn(payload);
                } catch (err) {
                    console.error(`Error in listener for event "${event}":`, err);
                }
            }
        }
    }
}

/**
 * CandleAggregator
 * Encapsulates timeframe quantization, active candle updates, out-of-order tick handling,
 * and period boundary transitions.
 */
export class CandleAggregator extends EventEmitter {
    public readonly timeframeMs: number;
    public history: Candle[] = [];
    public activeCandle: Candle | null = null;
    public lastProcessedTickTime = 0;
    public velocityY = 0;

    /**
     * @param timeframeSeconds Period in seconds (default 60 for 1m)
     */
    constructor(timeframeSeconds = 60) {
        super();
        this.timeframeMs = Math.max(1, timeframeSeconds) * 1000;
    }

    /**
     * Quantizes timestamp to period start boundary
     * candleTimestamp = Math.floor(eventTimestamp / (periodInSeconds * 1000)) * (periodInSeconds * 1000)
     */
    quantizeTimestamp(timestampMs: UnixMS): UnixMS {
        return Math.floor(timestampMs / this.timeframeMs) * this.timeframeMs;
    }

    /**
     * Seed aggregator state with historical candles (REST API)
     */
    seedHistory(candles: Array<OHLCV | { time: number; open: number; high: number; low: number; close: number; volume?: number }>): void {
        if (!candles || candles.length === 0) return;

        const sorted: Candle[] = candles
            .map((c) => ({
                timestamp: 'time' in c ? c.time : (c as any).timestamp,
                open: Number(c.open),
                high: Number(c.high),
                low: Number(c.low),
                close: Number(c.close),
                volume: Number(c.volume ?? 0),
                finalized: true,
            }))
            .sort((a, b) => a.timestamp - b.timestamp);

        const now = Date.now();
        const currentPeriodBoundary = this.quantizeTimestamp(now);
        const last = sorted[sorted.length - 1];

        if (last && last.timestamp === currentPeriodBoundary) {
            this.history = sorted.slice(0, sorted.length - 1);
            this.activeCandle = { ...last, finalized: false };
        } else {
            this.history = sorted;
            this.activeCandle = null;
        }

        this.emit('history:loaded', this.getFullSeries());
    }

    /**
     * Process an incoming real-time price tick (OHLC aggregation logic)
     */
    processTick(tick: Tick): void {
        const { price, timestamp, volume = 1 } = tick;

        if (price == null || isNaN(price) || price <= 0 || timestamp == null || isNaN(timestamp)) {
            return;
        }

        // Deduplication & stale check: ignore ticks older than 30 seconds before last processed tick
        if (timestamp < this.lastProcessedTickTime - 30_000) {
            return;
        }
        this.lastProcessedTickTime = Math.max(this.lastProcessedTickTime, timestamp);

        const periodTimestamp = this.quantizeTimestamp(timestamp);

        // Case 1: First tick or new active candle initialization
        if (!this.activeCandle) {
            this.activeCandle = {
                timestamp: periodTimestamp,
                open: price,
                high: price,
                low: price,
                close: price,
                volume,
                finalized: false,
            };
            this.emit('candle:appended', { ...this.activeCandle });
            return;
        }

        // Case 2: Tick falls within current ActiveCandle period
        if (periodTimestamp === this.activeCandle.timestamp) {
            this.activeCandle.close = price;
            this.activeCandle.high = Math.max(this.activeCandle.high, price);
            this.activeCandle.low = Math.min(this.activeCandle.low, price);
            this.activeCandle.volume += volume;

            this.emit('candle:update', { ...this.activeCandle });
            return;
        }

        // Case 3: Period boundary crossed -> finalize ActiveCandle & instantiate new ActiveCandle
        if (periodTimestamp > this.activeCandle.timestamp) {
            this.activeCandle.finalized = true;
            this.history.push({ ...this.activeCandle });
            this.emit('candle:finalized', { ...this.activeCandle });

            this.activeCandle = {
                timestamp: periodTimestamp,
                open: price,
                high: price,
                low: price,
                close: price,
                volume,
                finalized: false,
            };

            this.emit('candle:appended', { ...this.activeCandle });
            return;
        }

        // Case 4: Delayed / Out-of-order tick received for an older/finalized candle
        if (periodTimestamp < this.activeCandle.timestamp) {
            const histIdx = this.history.findIndex((c) => c.timestamp === periodTimestamp);
            if (histIdx !== -1) {
                const candle = this.history[histIdx]!;
                candle.high = Math.max(candle.high, price);
                candle.low = Math.min(candle.low, price);
                candle.volume += volume;
                this.emit('candle:patch', { ...candle, index: histIdx });
            }
        }
    }

    /**
     * Return complete series (history + active candle)
     */
    getFullSeries(): Candle[] {
        const list = [...this.history];
        if (this.activeCandle) {
            list.push({ ...this.activeCandle });
        }
        return list;
    }
}
