/**
 * High-Frequency CPU Smooth Candle Interpolator & WebGL GPU Pipeline
 *
 * Mathematical Foundations:
 * - Frame-Rate Independent Exponential Decay:
 *   Y_current(t + dt) = Y_current(t) + (Y_target - Y_current(t)) * alpha
 *   alpha(dt) = 1.0 - exp(-dt / tau)
 * - Coordinate Space Projection:
 *   vec2 clipSpace = (a_position / u_resolution) * 2.0 - 1.0;
 *   gl_Position = vec4(clipSpace * vec2(1.0, -1.0), 0.0, 1.0);
 */

export interface OHLC {
    open: number;
    high: number;
    low: number;
    close: number;
    timestamp?: number;
    volume?: number;
}

// ============================================================================
// 1. CPU Smooth Interpolation Engine
// ============================================================================

export class CandleInterpolator {
    public alpha: number;
    public target: OHLC = { open: 0, high: 0, low: 0, close: 0 };
    public current: OHLC = { open: 0, high: 0, low: 0, close: 0 };
    private initialized = false;

    /**
     * @param smoothingAlpha Base smoothing factor per frame (default ~0.12 or time-constant based)
     */
    constructor(smoothingAlpha = 0.12) {
        this.alpha = smoothingAlpha;
    }

    /**
     * Ingests latest OHLC target from the WebSocket stream.
     */
    public setTarget(ohlc: OHLC): void {
        this.target.open = ohlc.open;
        this.target.high = ohlc.high;
        this.target.low = ohlc.low;
        this.target.close = ohlc.close;

        // Initialize position immediately on first candle creation / bucket open
        if (!this.initialized || this.current.open === 0) {
            this.current.open = ohlc.open;
            this.current.high = ohlc.high;
            this.current.low = ohlc.low;
            this.current.close = ohlc.close;
            this.initialized = true;
        }
    }

    /**
     * Evaluates continuous interpolation step on every requestAnimationFrame tick.
     * @param dynamicAlpha Optional frame-rate calibrated alpha: 1.0 - exp(-dt / tau)
     */
    public update(dynamicAlpha?: number): OHLC {
        const a = dynamicAlpha !== undefined ? dynamicAlpha : this.alpha;

        // Exponential decay toward targets
        this.current.close += (this.target.close - this.current.close) * a;
        this.current.high += (this.target.high - this.current.high) * a;
        this.current.low += (this.target.low - this.current.low) * a;
        this.current.open = this.target.open; // Open price remains static

        // Physical bounds invariant (high >= max(open, close), low <= min(open, close))
        if (this.current.close > this.current.high) this.current.high = this.current.close;
        if (this.current.close < this.current.low) this.current.low = this.current.close;
        this.current.high = Math.max(this.current.high, this.current.open);
        this.current.low = Math.min(this.current.low, this.current.open);

        return this.current;
    }
}

// ============================================================================
// 2. WebGL Buffer Packager & Pipeline
// ============================================================================

export const VERTEX_SHADER_SOURCE = `
attribute vec2 a_position;
uniform vec2 u_resolution;

void main() {
    // Convert coordinate from pixel space to clip space [-1.0, 1.0]
    vec2 zeroToOne = a_position / u_resolution;
    vec2 zeroToTwo = zeroToOne * 2.0;
    vec2 clipSpace = zeroToTwo - 1.0;

    gl_Position = vec4(clipSpace * vec2(1.0, -1.0), 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER_SOURCE = `
precision mediump float;
uniform vec4 u_color;

void main() {
    gl_FragColor = u_color;
}
`;

export class WebGLCandleRenderer {
    public canvas: HTMLCanvasElement;
    public gl: WebGLRenderingContext | WebGL2RenderingContext;
    private program!: WebGLProgram;
    private vbo!: WebGLBuffer;
    private positionAttr = -1;
    private resolutionUniform: WebGLUniformLocation | null = null;
    private colorUniform: WebGLUniformLocation | null = null;

    // Pre-allocated static Float32Array (16 floats = 2 vertices for wick + 6 vertices for body = 8 * 2 = 16 floats = 64 bytes)
    public readonly vertexBuffer = new Float32Array(16);

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!gl) {
            throw new Error('WebGL is not supported on this platform');
        }
        this.gl = gl;

        this.initShaders();
        this.initBuffers();
    }

    private initShaders(): void {
        const gl = this.gl;
        const createShader = (type: number, src: string): WebGLShader => {
            const s = gl.createShader(type);
            if (!s) throw new Error('Failed to create shader');
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
                const info = gl.getShaderInfoLog(s);
                gl.deleteShader(s);
                throw new Error(`Shader compile error: ${info}`);
            }
            return s;
        };

        const vs = createShader(gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
        const fs = createShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);

        const program = gl.createProgram();
        if (!program) throw new Error('Failed to create WebGL program');
        this.program = program;

        gl.attachShader(this.program, vs);
        gl.attachShader(this.program, fs);
        gl.linkProgram(this.program);

        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
            const info = gl.getProgramInfoLog(this.program);
            throw new Error(`Program link error: ${info}`);
        }

        gl.useProgram(this.program);

        this.positionAttr = gl.getAttribLocation(this.program, 'a_position');
        this.resolutionUniform = gl.getUniformLocation(this.program, 'u_resolution');
        this.colorUniform = gl.getUniformLocation(this.program, 'u_color');
    }

    private initBuffers(): void {
        const gl = this.gl;
        const buffer = gl.createBuffer();
        if (!buffer) throw new Error('Failed to create VBO');
        this.vbo = buffer;

        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        // Pre-allocate dynamic array stream for vertices (16 floats * 4 = 64 bytes)
        gl.bufferData(gl.ARRAY_BUFFER, this.vertexBuffer.byteLength, gl.DYNAMIC_DRAW);
    }

    /**
     * Transforms continuous OHLC physical values to screen coordinates and renders via WebGL.
     */
    public render(ohlc: OHLC, xPosition: number, candleWidth: number): void {
        const gl = this.gl;

        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.useProgram(this.program);
        gl.uniform2f(this.resolutionUniform, this.canvas.width, this.canvas.height);

        const isBullish = ohlc.close >= ohlc.open;
        // In screen pixel coordinates, higher price = smaller Y
        const bodyTop = Math.min(ohlc.open, ohlc.close);
        const bodyBottom = Math.max(ohlc.open, ohlc.close);

        const halfWidth = candleWidth / 2;
        const wickX = xPosition;

        // Fill pre-allocated Float32Array directly (zero allocations)
        const v = this.vertexBuffer;

        // Wick Line: Top (High) to Bottom (Low)
        v[0] = wickX;  v[1] = ohlc.high;
        v[2] = wickX;  v[3] = ohlc.low;

        // Body Quad: Triangle 1 (TL, TR, BL)
        v[4] = xPosition - halfWidth; v[5] = bodyTop;
        v[6] = xPosition + halfWidth; v[7] = bodyTop;
        v[8] = xPosition - halfWidth; v[9] = bodyBottom;

        // Body Quad: Triangle 2 (BL, TR, BR)
        v[10] = xPosition - halfWidth; v[11] = bodyBottom;
        v[12] = xPosition + halfWidth; v[13] = bodyTop;
        v[14] = xPosition + halfWidth; v[15] = bodyBottom;

        // Upload to GPU
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, v);

        gl.enableVertexAttribArray(this.positionAttr);
        gl.vertexAttribPointer(this.positionAttr, 2, gl.FLOAT, false, 0, 0);

        // Bullish Green [0.25, 0.72, 0.31] | Bearish Red [0.97, 0.32, 0.29]
        if (isBullish) {
            gl.uniform4f(this.colorUniform, 0.25, 0.72, 0.31, 1.0);
        } else {
            gl.uniform4f(this.colorUniform, 0.97, 0.32, 0.29, 1.0);
        }

        // Draw Wick (LINES: 2 vertices)
        gl.drawArrays(gl.LINES, 0, 2);

        // Draw Body (TRIANGLES: 6 vertices starting at index 2)
        gl.drawArrays(gl.TRIANGLES, 2, 6);
    }
}

// ============================================================================
// 3. State Management & Timeframe Aggregator
// ============================================================================

export class CandleStateManager {
    public readonly timeframeSeconds: number;
    public activeCandle: OHLC | null = null;

    constructor(timeframeSeconds = 60) {
        this.timeframeSeconds = timeframeSeconds;
    }

    public processTick(price: number, timestampMs: number): OHLC {
        const periodMs = this.timeframeSeconds * 1000;
        const bucketTime = Math.floor(timestampMs / periodMs) * periodMs;

        if (!this.activeCandle || this.activeCandle.timestamp !== bucketTime) {
            this.activeCandle = {
                timestamp: bucketTime,
                open: price,
                high: price,
                low: price,
                close: price,
                volume: 1,
            };
        } else {
            this.activeCandle.high = Math.max(this.activeCandle.high, price);
            this.activeCandle.low = Math.min(this.activeCandle.low, price);
            this.activeCandle.close = price;
            this.activeCandle.volume = (this.activeCandle.volume ?? 0) + 1;
        }

        return this.activeCandle;
    }
}

// ============================================================================
// 4. Master Orchestrator (Main App Loop)
// ============================================================================

export class ChartApplication {
    public renderer: WebGLCandleRenderer;
    public stateManager: CandleStateManager;
    public interpolator: CandleInterpolator;
    private running = false;
    private animHandle = 0;
    private lastTime = 0;

    constructor(canvas: HTMLCanvasElement, timeframeSeconds = 60, smoothingAlpha = 0.12) {
        this.renderer = new WebGLCandleRenderer(canvas);
        this.stateManager = new CandleStateManager(timeframeSeconds);
        this.interpolator = new CandleInterpolator(smoothingAlpha);
    }

    public onTick(price: number, timestampMs = Date.now()): void {
        const activeCandle = this.stateManager.processTick(price, timestampMs);
        this.interpolator.setTarget(activeCandle);
    }

    public start(): void {
        if (this.running) return;
        this.running = true;
        this.lastTime = performance.now();

        const loop = (now: number) => {
            if (!this.running) return;

            const dtMs = now - this.lastTime;
            this.lastTime = now;

            // Frame-rate independent continuous alpha: alpha = 1.0 - exp(-dt / tau)
            // with tau = 90ms (equivalent to ~0.12 alpha at 60fps)
            const tau = 90;
            const alpha = 1.0 - Math.exp(-Math.min(dtMs, 64) / tau);

            // 1. Calculate next interpolated position frame on CPU
            const interpolatedCandle = this.interpolator.update(alpha);

            // 2. Push updated vertices to GPU buffer and render
            const canvasCenterX = this.renderer.canvas.width / 2;
            const candleWidth = 20;

            this.renderer.render(interpolatedCandle, canvasCenterX, candleWidth);

            this.animHandle = requestAnimationFrame(loop);
        };

        this.animHandle = requestAnimationFrame(loop);
    }

    public stop(): void {
        this.running = false;
        if (typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(this.animHandle);
        }
    }
}
