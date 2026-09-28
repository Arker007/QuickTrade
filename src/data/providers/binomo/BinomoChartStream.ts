import { CandleAggregator, EventEmitter, type Candle, type Tick } from './CandleAggregator';
import type { OHLCV } from '../../../core/model/ohlcv';

export type StreamStatus = 'DISCONNECTED' | 'BOOTSTRAPPING' | 'CONNECTED' | 'RECONNECTING' | 'ERROR';

export interface BinomoChartStreamOptions {
    symbol: string;
    timeframeSeconds?: number;
    wsUrl?: string;
    restBaseUrl?: string;
    customFetch?: typeof fetch;
    customWebSocket?: typeof WebSocket;
}

export class BinomoChartStream extends EventEmitter {
    public readonly symbol: string;
    public readonly timeframeSeconds: number;
    public readonly wsUrl: string;
    public readonly restBaseUrl: string;

    public readonly aggregator: CandleAggregator;
    public status: StreamStatus = 'DISCONNECTED';
    public isBootstrapping = true;

    private ws: WebSocket | null = null;
    private eventSource: EventSource | null = null;
    private refCounter = 0;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private tickQueue: Tick[] = [];
    private fetchFn: typeof fetch;
    private WebSocketCls: typeof WebSocket | undefined;

    constructor(options: BinomoChartStreamOptions) {
        super();
        this.symbol = options.symbol;
        this.timeframeSeconds = options.timeframeSeconds ?? 60;
        this.wsUrl = options.wsUrl ?? 'wss://ws.binomo.com/socket/websocket';
        this.restBaseUrl = options.restBaseUrl ?? '';
        this.fetchFn = options.customFetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : fetch);
        this.WebSocketCls = options.customWebSocket ?? (typeof WebSocket !== 'undefined' ? WebSocket : undefined);

        this.aggregator = new CandleAggregator(this.timeframeSeconds);

        // Forward aggregator events
        this.aggregator.on('candle:update', (c) => this.emit('candle:update', c));
        this.aggregator.on('candle:finalized', (c) => this.emit('candle:finalized', c));
        this.aggregator.on('candle:appended', (c) => this.emit('candle:appended', c));
        this.aggregator.on('candle:patch', (c) => this.emit('candle:patch', c));
        this.aggregator.on('history:loaded', (h) => this.emit('history:loaded', h));
    }

    /**
     * Start the stream: Connect WebSocket / SSE, queue ticks, fetch REST history, replay queue
     */
    async start(): Promise<void> {
        this.setStatus('BOOTSTRAPPING');
        this.isBootstrapping = true;
        this.tickQueue = [];

        // 1. Connect WebSocket / SSE stream
        this.connectStream();

        // 2. Fetch REST history
        try {
            const history = await this.fetchRESTHistory(this.symbol, this.timeframeSeconds);
            this.aggregator.seedHistory(history);
        } catch (err) {
            console.error('[BinomoChartStream] Failed to fetch REST history:', err);
            this.emit('error', err as any);
        } finally {
            // 3. Replay queued ticks through aggregator
            this.isBootstrapping = false;
            this.drainQueue();
            if (this.status !== 'DISCONNECTED') {
                this.setStatus('CONNECTED');
            }
        }
    }

    public setStatus(status: StreamStatus): void {
        if (this.status !== status) {
            this.status = status;
            this.emit('status:change' as any, status as any);
        }
    }

    /**
     * Drain and process queued ticks accumulated during bootstrapping
     */
    public drainQueue(): void {
        if (this.tickQueue.length > 0) {
            this.tickQueue.sort((a, b) => a.timestamp - b.timestamp);
            for (const tick of this.tickQueue) {
                this.aggregator.processTick(tick);
            }
            this.tickQueue = [];
        }
    }

    private getTopicAsset(sym: string): string {
        const raw = sym.trim().toUpperCase();
        if (
            raw === 'CRYPTO_IDX' ||
            raw === 'Z-CRY/IDX' ||
            raw === 'Z-CRY%2FIDX' ||
            raw === 'CRYPTO' ||
            raw === 'ZCRYIDX' ||
            raw === 'CRYIDX' ||
            raw.replace(/[^A-Z]/g, '') === 'CRYPTOIDX'
        ) {
            return 'Z-CRY/IDX';
        }
        if (raw === 'EURUSD' || raw === 'EURO') {
            return 'EURO';
        }
        return raw.includes('/') ? raw.replace(/\//g, '%2F') : raw;
    }

    private connectStream(): void {
        const topicAsset = this.getTopicAsset(this.symbol);
        // Prefer native WebSocket if available or provided
        if (this.WebSocketCls) {
            try {
                this.ws = new this.WebSocketCls(this.wsUrl);

                this.ws.onopen = () => {
                    this.startHeartbeat();
                    this.joinPhoenixChannel(`range_stream:${topicAsset}`);
                    this.joinPhoenixChannel(`asset:${topicAsset}`);
                };

                this.ws.onmessage = (e: MessageEvent) => {
                    this.handleMessage(e.data);
                };

                this.ws.onerror = (err) => {
                    this.emit('error', err as any);
                };

                this.ws.onclose = () => {
                    this.stopHeartbeat();
                    if (this.status !== 'DISCONNECTED') {
                        this.setStatus('RECONNECTING');
                        this.scheduleReconnect();
                    }
                };
                return;
            } catch {
                // Fall through to SSE fallback
            }
        }

        // SSE fallback in browser environment with proxy
        if (typeof window !== 'undefined' && typeof EventSource !== 'undefined') {
            try {
                void this.fetchFn(`/api/binomo/join?asset=${encodeURIComponent(topicAsset)}`).catch(() => {});

                this.eventSource = new EventSource(`/events?asset=${encodeURIComponent(topicAsset)}`);
                this.eventSource.onmessage = (e: MessageEvent) => {
                    this.handleMessage(e.data);
                };
                this.eventSource.onerror = () => {
                    if (this.status !== 'DISCONNECTED') {
                        this.setStatus('RECONNECTING');
                        this.scheduleReconnect();
                    }
                };
            } catch (err) {
                this.emit('error', err as any);
            }
        }
    }

    private nextRef(): string {
        this.refCounter += 1;
        return String(this.refCounter);
    }

    private joinPhoenixChannel(topic: string): void {
        if (!this.ws || this.ws.readyState !== 1 /* OPEN */) return;

        const ref = this.nextRef();
        const frame = {
            topic,
            event: 'phx_join',
            payload: {},
            ref,
            join_ref: ref,
        };

        this.ws.send(JSON.stringify(frame));
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.pingTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === 1 /* OPEN */) {
                this.ws.send(
                    JSON.stringify({
                        topic: 'phoenix',
                        event: 'heartbeat',
                        payload: {},
                        ref: this.nextRef(),
                    }),
                );
            }
        }, 30_000);
    }

    private stopHeartbeat(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.start();
        }, 3000);
    }

    /**
     * Handle incoming WebSocket or EventSource raw JSON string message frame
     */
    public handleMessage(rawData: string): void {
        try {
            const frame = JSON.parse(rawData);
            if (!frame || typeof frame !== 'object') return;

            const { event, payload } = frame;
            if (event === 'phx_reply') return;

            let price: number | null = null;
            let timestamp = Date.now();

            const parseCreatedAt = (val: any) => {
                if (!val) return;
                const ms = parseUTCDate(val);
                if (ms > 0) {
                    timestamp = ms;
                }
            };

            if (payload) {
                if (typeof payload.rate === 'number') {
                    price = payload.rate;
                    parseCreatedAt(payload.created_at);
                } else if (typeof payload.close === 'number') {
                    price = payload.close;
                    parseCreatedAt(payload.created_at);
                } else if (typeof payload.value === 'number') {
                    price = payload.value;
                    parseCreatedAt(payload.created_at);
                } else if (typeof payload.price === 'number') {
                    price = payload.price;
                    parseCreatedAt(payload.created_at);
                } else if (Array.isArray(payload.data) && payload.data.length > 0) {
                    const last = payload.data[payload.data.length - 1];
                    if (last && typeof last.close === 'number') {
                        price = last.close;
                        parseCreatedAt(last.created_at ?? payload.created_at);
                    } else if (last && typeof last.rate === 'number') {
                        price = last.rate;
                        parseCreatedAt(last.created_at ?? payload.created_at);
                    }
                }
            }

            if (price !== null && !isNaN(price) && price > 0) {
                const tick: Tick = { price, timestamp };

                if (this.isBootstrapping) {
                    this.tickQueue.push(tick);
                } else {
                    this.aggregator.processTick(tick);
                }
            }
        } catch {
            // ignore invalid frame
        }
    }

    /**
     * Fetch REST history for bootstrapping
     */
    public async fetchRESTHistory(symbol: string, timeframeSeconds: number): Promise<OHLCV[]> {
        let apiSymbol = symbol.trim().toUpperCase();
        if (apiSymbol === 'CRYPTO_IDX' || apiSymbol === 'Z-CRY/IDX') {
            apiSymbol = 'Z-CRY%2FIDX';
        } else if (apiSymbol === 'EURUSD' || apiSymbol === 'EURO') {
            apiSymbol = 'EURO';
        } else if (apiSymbol.includes('/')) {
            apiSymbol = apiSymbol.replace(/\//g, '%2F');
        }

        const todayUTC = new Date();
        const dateStr = `${todayUTC.getUTCFullYear()}-${String(todayUTC.getUTCMonth() + 1).padStart(2, '0')}-${String(todayUTC.getUTCDate()).padStart(2, '0')}T00:00:00`;
        const url = `${this.restBaseUrl}/api/binomo/candles/v1/${apiSymbol}/${dateStr}/60?locale=en`;

        const res = await this.fetchFn(url);
        if (!res.ok) {
            throw new Error(`REST candle fetch failed with status ${res.status}`);
        }

        const json = (await res.json()) as { data?: Array<{ open: number; high: number; low: number; close: number; volume?: number; created_at: string }> };
        const rawData = json.data ?? [];

        return rawData.map((item) => {
            const closeTime = parseUTCDate(item.created_at);
            const periodMs = timeframeSeconds * 1000;
            const time = Math.floor(closeTime / periodMs) * periodMs - periodMs;
            return {
                time,
                open: Number(item.open),
                high: Number(item.high),
                low: Number(item.low),
                close: Number(item.close),
                volume: Number(item.volume ?? 0),
            };
        });
    }

    /**
     * Stop and cleanup stream
     */
    stop(): void {
        this.setStatus('DISCONNECTED');
        this.stopHeartbeat();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
        }
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
    }
}

/**
 * Attach stream to chart renderer interface
 */
export function attachStreamToChart(
    stream: BinomoChartStream,
    renderer: {
        setData: (candles: Candle[] | OHLCV[]) => void;
        update: (candle: Candle | OHLCV) => void;
    },
): void {
    stream.on('history:loaded', (history) => {
        renderer.setData(history);
    });

    stream.on('candle:update', (candle) => {
        renderer.update(candle);
    });

    stream.on('candle:appended', (candle) => {
        renderer.update(candle);
    });
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
