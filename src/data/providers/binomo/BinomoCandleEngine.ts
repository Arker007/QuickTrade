export interface CandleState {
  open: number;        // Y pixel position for Open
  close: number;       // Current interpolated Y pixel position for Close
  targetClose: number; // Raw incoming WebSocket price tick
  x: number;           // Center X position on canvas
  width: number;       // Candle body width in pixels
}

export class BinomoCandleEngine {
  private gl: WebGLRenderingContext | WebGL2RenderingContext;
  private program: WebGLProgram;
  private uTransform: WebGLUniformLocation;
  private uResolution: WebGLUniformLocation;
  private uColor: WebGLUniformLocation;
  private vbo: WebGLBuffer;

  // Exact Unit Quad buffer captured from Binomo source
  private readonly unitVertices = new Float32Array([
    -1, -1,
    -1,  1,
     1, -1,
     1,  1
  ]);

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) throw new Error('WebGL not supported');
    this.gl = gl;

    // Shaders using Binomo's exact u_transform matrix approach
    const vs = `
      attribute vec2 a_position;
      uniform mat3 u_transform;
      uniform vec2 u_resolution;
      void main() {
        vec3 transformed = u_transform * vec3(a_position, 1.0);
        vec2 zeroToOne = transformed.xy / u_resolution;
        vec2 zeroToTwo = zeroToOne * 2.0;
        vec2 clipSpace = zeroToTwo - 1.0;
        gl_Position = vec4(clipSpace.x, -clipSpace.y, 0.0, 1.0);
      }
    `;

    const fs = `
      precision mediump float;
      uniform vec4 u_color;
      void main() { gl_FragColor = u_color; }
    `;

    // Compile Shader Program
    const createShader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };

    this.program = gl.createProgram()!;
    gl.attachShader(this.program, createShader(gl.VERTEX_SHADER, vs));
    gl.attachShader(this.program, createShader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(this.program);

    // Uniform Locations
    this.uTransform = gl.getUniformLocation(this.program, 'u_transform')!;
    this.uResolution = gl.getUniformLocation(this.program, 'u_resolution')!;
    this.uColor = gl.getUniformLocation(this.program, 'u_color')!;

    // VBO Initialization
    this.vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.unitVertices, gl.STATIC_DRAW);
  }

  /** Linear Interpolation (Binomo's smooth movement factor) */
  public lerp(start: number, end: number, factor: number = 0.12): number {
    return start + (end - start) * factor;
  }

  /** Render a single frame */
  public render(candle: CandleState): void {
    const gl = this.gl;

    // 1. Smoothly interpolate current price towards WebSocket target
    candle.close = this.lerp(candle.close, candle.targetClose);

    // 2. Compute Candle Matrix dimensions
    const topY = Math.min(candle.open, candle.close);
    const halfHeight = Math.max(Math.abs(candle.close - candle.open), 2.0) / 2;
    const centerY = topY + halfHeight;
    const halfWidth = candle.width / 2;

    // 3. Build 3x3 Transformation Matrix (Column-major Float32Array(9))
    const u_transform = new Float32Array([
      halfWidth, 0,          0,
      0,         halfHeight, 0,
      candle.x,  centerY,    1
    ]);

    // 4. Viewport & Clear
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.118, 0.133, 0.176, 1.0); // palette-exempt: Binomo default dark background (#1e222d)
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);

    // 5. Bind Buffer Attributes
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const aPos = gl.getAttribLocation(this.program, 'a_position');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // 6. Set Uniforms
    gl.uniform2f(this.uResolution, this.canvas.width, this.canvas.height);
    gl.uniformMatrix3fv(this.uTransform, false, u_transform);

    // Green (#00c853) if bullish, Red (#ff3d00) if bearish // palette-exempt: Binomo default candle up/down colors
    const isBullish = candle.close >= candle.open;
    gl.uniform4f(
      this.uColor,
      isBullish ? 0.0 : 1.0,
      isBullish ? 0.784 : 0.239,
      isBullish ? 0.325 : 0.0,
      1.0
    );

    // 7. Exact GPU draw call extracted from Binomo's renderer
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
