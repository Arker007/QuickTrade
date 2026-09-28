/**
 * High-Performance Financial Visualization & WebGL Candle Animation Engine
 *
 * Architecture:
 * - Asynchronous Ingestion & Target Latching (Zero Garbage Collection)
 * - Continuous Exponential Decay Interpolation: alpha = 1.0 - exp(-dt / tau)
 * - Dynamic Extrema Enclosing Bounds (Wick Invariants)
 * - 32-Byte Aligned Interleaved WebGL2 Vertex Buffer with gl.bufferSubData Streaming
 */

export class SmoothCandleEngine {
    // Physical rendered states
    public open = 0;
    public high = 0;
    public low = 0;
    public close = 0;

    // Stream target states
    public targetClose = 0;
    public targetHigh = 0;
    public targetLow = 0;
    public time = 0;

    // Time constant tau in milliseconds (90ms -> ~95% convergence in ~270ms)
    private tau = 90;
    private readonly eps = 1e-5;

    // Pre-allocated Float32Array for GPU streaming: [open, high, low, close, velocity]
    public readonly gpuPayload = new Float32Array(5);

    /**
     * Initializes the engine with baseline candle parameters.
     */
    public init(open: number, high: number, low: number, close: number, time: number, tauMs = 90): void {
        this.open = open;
        this.high = high;
        this.low = low;
        this.close = close;

        this.targetClose = close;
        this.targetHigh = high;
        this.targetLow = low;
        this.time = time;
        this.tau = Math.max(0, tauMs);

        this.syncPayload(0);
    }

    /**
     * Ingests a new incoming price tick asynchronously from the WebSocket feed.
     * Zero allocations - mutates target properties directly.
     */
    public onTick(price: number, externalHigh?: number, externalLow?: number): void {
        this.targetClose = price;

        // Expand target boundaries immediately if incoming price breaches extrema
        const refHigh = externalHigh !== undefined ? Math.max(price, externalHigh) : price;
        const refLow = externalLow !== undefined ? Math.min(price, externalLow) : price;

        if (refHigh > this.targetHigh) this.targetHigh = refHigh;
        if (refLow < this.targetLow) this.targetLow = refLow;
    }

    /**
     * Evaluates continuous exponential decay for the active frame.
     * @param dtMs Elapsed time since previous frame in milliseconds.
     * @returns True if interpolation is active; false if settled.
     */
    public update(dtMs: number): boolean {
        if (this.tau <= 0) {
            this.close = this.targetClose;
            this.high = this.targetHigh;
            this.low = this.targetLow;
            this.syncPayload(0);
            return false;
        }

        // Clamp dt to 64ms (prevents huge jumps if tab was backgrounded)
        const dtClamped = dtMs > 64 ? 64 : (dtMs < 0 ? 0 : dtMs);

        // Frame-rate independent exponential smoothing factor
        const alpha = 1.0 - Math.exp(-dtClamped / this.tau);

        // 1. Close Price Exponential Interpolation
        const deltaClose = this.targetClose - this.close;
        const velocity = deltaClose * alpha;
        this.close += velocity;

        // 2. High & Low Continuous Asymptotic Glide
        const deltaHigh = this.targetHigh - this.high;
        this.high += deltaHigh * alpha;

        const deltaLow = this.targetLow - this.low;
        this.low += deltaLow * alpha;

        // 3. Dynamic Wick Enclosing Invariant (Strict Physical Bounds)
        if (this.close > this.high) this.high = this.close;
        if (this.close < this.low) this.low = this.close;
        this.high = Math.max(this.high, this.open);
        this.low = Math.min(this.low, this.open);

        // 4. Convergence Test
        const closeDiff = Math.abs(this.targetClose - this.close);
        const highDiff = Math.abs(this.targetHigh - this.high);
        const lowDiff = Math.abs(this.targetLow - this.low);

        const isSettled = closeDiff <= this.eps && highDiff <= this.eps && lowDiff <= this.eps;

        if (isSettled) {
            this.close = this.targetClose;
            this.high = Math.max(this.targetHigh, this.open);
            this.low = Math.min(this.targetLow, this.open);
        }

        this.syncPayload(velocity);
        return !isSettled;
    }

    private syncPayload(velocity: number): void {
        this.gpuPayload[0] = this.open;
        this.gpuPayload[1] = this.high;
        this.gpuPayload[2] = this.low;
        this.gpuPayload[3] = this.close;
        this.gpuPayload[4] = velocity;
    }
}

/**
 * 32-Byte Interleaved Vertex Layout:
 * ----------------------------------------------------------------------------
 * Offset | Field       | Type           | Bytes | Description
 * ----------------------------------------------------------------------------
 * 0x00   | aPos        | Float32 [2]    | 8     | Screen X, Y
 * 0x08   | aColor      | Uint8   [4]    | 4     | RGBA (Normalized)
 * 0x0C   | aEdge       | Float32 [2]    | 8     | Signed Distance & Line Width
 * 0x14   | aParams     | Float32 [2]    | 8     | Quad ID & Smoothing Velocity
 * 0x1C   | _pad        | Float32 [1]    | 4     | 32-Byte SIMD Alignment Padding
 * ----------------------------------------------------------------------------
 * Total: 32 Bytes per vertex.
 */
export const VERTEX_STRIDE_BYTES = 32;
export const VERTEX_STRIDE_FLOATS = VERTEX_STRIDE_BYTES / 4; // 8 Floats

export class DynamicCandleBufferStream {
    private gl: WebGL2RenderingContext;
    private vbo: WebGLBuffer;

    // Double-buffered host memory views for zero-allocation mutations
    private rawBuffer: ArrayBuffer;
    private floatView: Float32Array;
    private uint32View: Uint32Array;

    private readonly maxVertices: number;
    private vertexCount = 0;

    constructor(gl: WebGL2RenderingContext, maxCandles = 500) {
        this.gl = gl;
        // 3 Quads (Upper Wick, Body, Lower Wick) = 6 vertices each = 18 vertices / candle
        this.maxVertices = maxCandles * 18;

        const totalBytes = this.maxVertices * VERTEX_STRIDE_BYTES;
        this.rawBuffer = new ArrayBuffer(totalBytes);
        this.floatView = new Float32Array(this.rawBuffer);
        this.uint32View = new Uint32Array(this.rawBuffer);

        const buffer = gl.createBuffer();
        if (!buffer) throw new Error('Failed to allocate WebGL VBO');
        this.vbo = buffer;

        // Static VRAM pre-allocation
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, totalBytes, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    public bindAttributes(program: WebGLProgram): void {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);

        const aPos = gl.getAttribLocation(program, 'aPos');
        const aColor = gl.getAttribLocation(program, 'aColor');
        const aEdge = gl.getAttribLocation(program, 'aEdge');
        const aParams = gl.getAttribLocation(program, 'aParams');

        if (aPos >= 0) {
            gl.enableVertexAttribArray(aPos);
            gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, VERTEX_STRIDE_BYTES, 0);
        }
        if (aColor >= 0) {
            gl.enableVertexAttribArray(aColor);
            gl.vertexAttribPointer(aColor, 4, gl.UNSIGNED_BYTE, true, VERTEX_STRIDE_BYTES, 8);
        }
        if (aEdge >= 0) {
            gl.enableVertexAttribArray(aEdge);
            gl.vertexAttribPointer(aEdge, 2, gl.FLOAT, false, VERTEX_STRIDE_BYTES, 12);
        }
        if (aParams >= 0) {
            gl.enableVertexAttribArray(aParams);
            gl.vertexAttribPointer(aParams, 2, gl.FLOAT, false, VERTEX_STRIDE_BYTES, 20);
        }
    }

    public reset(): void {
        this.vertexCount = 0;
    }

    /**
     * Emits a quad directly into the interleaved memory buffer (Zero Allocation).
     */
    public pushQuad(
        x0: number, y0: number,
        x1: number, y1: number,
        colorUint32: number,
        edgeX: number, edgeY: number,
        param0: number, param1: number
    ): void {
        if (this.vertexCount + 6 > this.maxVertices) return;

        let ptr = this.vertexCount * VERTEX_STRIDE_FLOATS;
        const fv = this.floatView;
        const uv = this.uint32View;

        // Triangle 1: Vertex 0 (x0, y0)
        fv[ptr + 0] = x0; fv[ptr + 1] = y0; uv[ptr + 2] = colorUint32;
        fv[ptr + 3] = edgeX; fv[ptr + 4] = edgeY; fv[ptr + 5] = param0; fv[ptr + 6] = param1;
        ptr += 8;

        // Triangle 1: Vertex 1 (x1, y0)
        fv[ptr + 0] = x1; fv[ptr + 1] = y0; uv[ptr + 2] = colorUint32;
        fv[ptr + 3] = edgeX; fv[ptr + 4] = edgeY; fv[ptr + 5] = param0; fv[ptr + 6] = param1;
        ptr += 8;

        // Triangle 1: Vertex 2 (x0, y1)
        fv[ptr + 0] = x0; fv[ptr + 1] = y1; uv[ptr + 2] = colorUint32;
        fv[ptr + 3] = edgeX; fv[ptr + 4] = edgeY; fv[ptr + 5] = param0; fv[ptr + 6] = param1;
        ptr += 8;

        // Triangle 2: Vertex 3 (x1, y0)
        fv[ptr + 0] = x1; fv[ptr + 1] = y0; uv[ptr + 2] = colorUint32;
        fv[ptr + 3] = edgeX; fv[ptr + 4] = edgeY; fv[ptr + 5] = param0; fv[ptr + 6] = param1;
        ptr += 8;

        // Triangle 2: Vertex 4 (x1, y1)
        fv[ptr + 0] = x1; fv[ptr + 1] = y1; uv[ptr + 2] = colorUint32;
        fv[ptr + 3] = edgeX; fv[ptr + 4] = edgeY; fv[ptr + 5] = param0; fv[ptr + 6] = param1;
        ptr += 8;

        // Triangle 2: Vertex 5 (x0, y1)
        fv[ptr + 0] = x0; fv[ptr + 1] = y1; uv[ptr + 2] = colorUint32;
        fv[ptr + 3] = edgeX; fv[ptr + 4] = edgeY; fv[ptr + 5] = param0; fv[ptr + 6] = param1;
        ptr += 8;

        this.vertexCount += 6;
    }

    /**
     * Uploads only active buffer regions to GPU VRAM using gl.bufferSubData.
     */
    public flushToGPU(): void {
        if (this.vertexCount === 0) return;
        const gl = this.gl;
        const subLengthFloats = this.vertexCount * VERTEX_STRIDE_FLOATS;
        const subView = this.floatView.subarray(0, subLengthFloats);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, subView);
    }

    public draw(): void {
        if (this.vertexCount === 0) return;
        this.gl.drawArrays(this.gl.TRIANGLES, 0, this.vertexCount);
    }
}
