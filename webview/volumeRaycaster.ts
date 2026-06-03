type Axis = 'axial' | 'coronal' | 'sagittal';

export interface TransferFunctionPoint {
  position: number;
  color: [number, number, number];
  opacity: number;
}

export interface RayMarchingConfig {
  stepSize: number;
  maxSteps: number;
  lightDirection: [number, number, number];
  ambient: number;
  diffuse: number;
  specular: number;
  shininess: number;
}

const DEFAULT_CONFIG: RayMarchingConfig = {
  stepSize: 0.005,
  maxSteps: 512,
  lightDirection: [0.5, 0.8, 0.6],
  ambient: 0.3,
  diffuse: 0.6,
  specular: 0.4,
  shininess: 32,
};

const DEFAULT_TRANSFER_FUNCTION: TransferFunctionPoint[] = [
  { position: 0.0, color: [0, 0, 0], opacity: 0.0 },
  { position: 0.2, color: [0.1, 0.1, 0.3], opacity: 0.0 },
  { position: 0.4, color: [0.2, 0.3, 0.8], opacity: 0.3 },
  { position: 0.6, color: [0.8, 0.3, 0.2], opacity: 0.6 },
  { position: 0.8, color: [1.0, 0.9, 0.4], opacity: 0.8 },
  { position: 1.0, color: [1.0, 1.0, 1.0], opacity: 1.0 },
];

export class VolumeRaycaster {
  private gl: WebGL2RenderingContext | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private program: WebGLProgram | null = null;
  private volumeTexture: WebGLTexture | null = null;
  private tfTexture: WebGLTexture | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  private config: RayMarchingConfig;
  private transferFunction: TransferFunctionPoint[];
  private volumeReady = false;
  private volumeSize = { nx: 0, ny: 0, nz: 0 };

  private vertexShaderSource = `#version 300 es
precision highp float;
in vec2 a_position;
out vec3 v_rayDir;
out vec3 v_rayOrigin;

uniform mat4 u_invViewProj;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  vec4 near = u_invViewProj * vec4(a_position, -1.0, 1.0);
  vec4 far = u_invViewProj * vec4(a_position, 1.0, 1.0);
  near /= near.w;
  far /= far.w;
  v_rayOrigin = near.xyz;
  v_rayDir = normalize(far.xyz - near.xyz);
}`;

  private fragmentShaderSource = `#version 300 es
precision highp float;
precision highp sampler3D;

in vec3 v_rayDir;
in vec3 v_rayOrigin;

out vec4 fragColor;

uniform sampler3D u_volume;
uniform sampler2D u_transferFunc;
uniform vec3 u_volumeSize;
uniform float u_stepSize;
uniform int u_maxSteps;
uniform float u_windowLevel;
uniform float u_windowWidth;
uniform vec3 u_lightDir;
uniform float u_ambient;
uniform float u_diffuse;
uniform float u_specular;
uniform float u_shininess;

vec2 intersectBox(vec3 orig, vec3 dir) {
  vec3 boxMin = vec3(0.0);
  vec3 boxMax = vec3(1.0);
  vec3 invDir = 1.0 / dir;
  vec3 tMin = (boxMin - orig) * invDir;
  vec3 tMax = (boxMax - orig) * invDir;
  vec3 t1 = min(tMin, tMax);
  vec3 t2 = max(tMin, tMax);
  float tNear = max(max(t1.x, t1.y), t1.z);
  float tFar = min(min(t2.x, t2.y), t2.z);
  return vec2(tNear, tFar);
}

vec3 computeGradient(vec3 pos) {
  float dx = 1.0 / u_volumeSize.x;
  float dy = 1.0 / u_volumeSize.y;
  float dz = 1.0 / u_volumeSize.z;
  float x0 = texture(u_volume, pos - vec3(dx, 0.0, 0.0)).r;
  float x1 = texture(u_volume, pos + vec3(dx, 0.0, 0.0)).r;
  float y0 = texture(u_volume, pos - vec3(0.0, dy, 0.0)).r;
  float y1 = texture(u_volume, pos + vec3(0.0, dy, 0.0)).r;
  float z0 = texture(u_volume, pos - vec3(0.0, 0.0, dz)).r;
  float z1 = texture(u_volume, pos + vec3(0.0, 0.0, dz)).r;
  return normalize(vec3(x1 - x0, y1 - y0, z1 - z0));
}

void main() {
  vec3 rayDir = normalize(v_rayDir);
  vec2 tHit = intersectBox(v_rayOrigin, rayDir);
  if (tHit.x > tHit.y) { fragColor = vec4(0.0); return; }
  tHit.x = max(tHit.x, 0.0);

  vec3 pos = v_rayOrigin + tHit.x * rayDir;
  vec4 accum = vec4(0.0);

  for (int i = 0; i < 512; i++) {
    if (i >= u_maxSteps) break;
    if (accum.a > 0.95) break;
    if (pos.x < 0.0 || pos.x > 1.0 || pos.y < 0.0 || pos.y > 1.0 || pos.z < 0.0 || pos.z > 1.0) break;

    float rawVal = texture(u_volume, pos).r;
    float lo = u_windowLevel - u_windowWidth * 0.5;
    float t = clamp((rawVal - lo) / max(u_windowWidth, 0.001), 0.0, 1.0);

    vec4 tfColor = texture(u_transferFunc, vec2(t, 0.5));

    if (tfColor.a > 0.01) {
      vec3 gradient = computeGradient(pos);
      vec3 normal = -gradient;
      float diff = max(dot(normal, normalize(u_lightDir)), 0.0);
      vec3 viewDir = -rayDir;
      vec3 halfDir = normalize(normalize(u_lightDir) + viewDir);
      float spec = pow(max(dot(normal, halfDir), 0.0), u_shininess);

      vec3 litColor = tfColor.rgb * (u_ambient + u_diffuse * diff) + vec3(u_specular * spec);
      accum.rgb += (1.0 - accum.a) * tfColor.a * litColor;
      accum.a += (1.0 - accum.a) * tfColor.a;
    }

    pos += rayDir * u_stepSize;
  }

  fragColor = vec4(accum.rgb, accum.a);
}`;

  constructor(config?: Partial<RayMarchingConfig>, tf?: TransferFunctionPoint[]) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.transferFunction = tf || [...DEFAULT_TRANSFER_FUNCTION];
  }

  init(canvas: HTMLCanvasElement): boolean {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false }) as WebGL2RenderingContext | null;
    if (!this.gl) return false;

    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, this.vertexShaderSource);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, this.fragmentShaderSource);
    if (!vs || !fs) return false;

    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      console.error('Ray marching program link error:', gl.getProgramInfoLog(this.program));
      return false;
    }

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vertexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(this.program, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.createTransferFunctionTexture();
    return true;
  }

  private compileShader(type: number, source: string): WebGLShader | null {
    const gl = this.gl!;
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader compile error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  uploadVolume(data: Float32Array, nx: number, ny: number, nz: number): boolean {
    const gl = this.gl;
    if (!gl) return false;

    if (this.volumeTexture) gl.deleteTexture(this.volumeTexture);
    this.volumeTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, this.volumeTexture);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R32F, nx, ny, nz, 0, gl.RED, gl.FLOAT, data);
    gl.bindTexture(gl.TEXTURE_3D, null);

    this.volumeSize = { nx, ny, nz };
    this.volumeReady = true;
    return true;
  }

  private createTransferFunctionTexture(): void {
    const gl = this.gl;
    if (!gl) return;

    const width = 256;
    const data = new Uint8Array(width * 4);

    for (let i = 0; i < width; i++) {
      const t = i / (width - 1);
      const color = this.sampleTransferFunction(t);
      data[i * 4] = Math.round(color[0] * 255);
      data[i * 4 + 1] = Math.round(color[1] * 255);
      data[i * 4 + 2] = Math.round(color[2] * 255);
      data[i * 4 + 3] = Math.round(color[3] * 255);
    }

    if (this.tfTexture) gl.deleteTexture(this.tfTexture);
    this.tfTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tfTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private sampleTransferFunction(t: number): [number, number, number, number] {
    const points = this.transferFunction;
    if (points.length === 0) return [0, 0, 0, 0];
    if (t <= points[0].position) return [...points[0].color, points[0].opacity];
    if (t >= points[points.length - 1].position) return [...points[points.length - 1].color, points[points.length - 1].opacity];

    for (let i = 0; i < points.length - 1; i++) {
      if (t >= points[i].position && t <= points[i + 1].position) {
        const f = (t - points[i].position) / (points[i + 1].position - points[i].position);
        return [
          points[i].color[0] + f * (points[i + 1].color[0] - points[i].color[0]),
          points[i].color[1] + f * (points[i + 1].color[1] - points[i].color[1]),
          points[i].color[2] + f * (points[i + 1].color[2] - points[i].color[2]),
          points[i].opacity + f * (points[i + 1].opacity - points[i].opacity),
        ];
      }
    }
    return [0, 0, 0, 0];
  }

  setTransferFunction(tf: TransferFunctionPoint[]): void {
    this.transferFunction = tf;
    this.createTransferFunctionTexture();
  }

  getTransferFunction(): TransferFunctionPoint[] {
    return [...this.transferFunction];
  }

  setConfig(config: Partial<RayMarchingConfig>): void {
    Object.assign(this.config, config);
  }

  render(
    viewMatrix: Float32Array,
    projMatrix: Float32Array,
    windowLevel: number,
    windowWidth: number
  ): boolean {
    const gl = this.gl;
    if (!gl || !this.program || !this.volumeReady) return false;

    gl.viewport(0, 0, this.canvas!.width, this.canvas!.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.program);

    const invViewProj = new Float32Array(16);
    const vp = new Float32Array(16);
    this.multiplyMatrices(vp, viewMatrix, projMatrix);
    this.invertMatrix(invViewProj, vp);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.program, 'u_invViewProj'), false, invViewProj);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.volumeTexture);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_volume'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.tfTexture);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_transferFunc'), 1);

    gl.uniform3f(gl.getUniformLocation(this.program, 'u_volumeSize'), this.volumeSize.nx, this.volumeSize.ny, this.volumeSize.nz);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_stepSize'), this.config.stepSize);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_maxSteps'), this.config.maxSteps);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_windowLevel'), windowLevel);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_windowWidth'), windowWidth);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_lightDir'), ...this.config.lightDirection);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_ambient'), this.config.ambient);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_diffuse'), this.config.diffuse);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_specular'), this.config.specular);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_shininess'), this.config.shininess);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    gl.disable(gl.BLEND);
    return true;
  }

  private multiplyMatrices(out: Float32Array, a: Float32Array, b: Float32Array): void {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        out[i * 4 + j] = 0;
        for (let k = 0; k < 4; k++) {
          out[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j];
        }
      }
    }
  }

  private invertMatrix(out: Float32Array, m: Float32Array): void {
    const inv = new Float32Array(16);
    inv[0] = m[5]*m[10]*m[15] - m[5]*m[11]*m[14] - m[9]*m[6]*m[15] + m[9]*m[7]*m[14] + m[13]*m[6]*m[11] - m[13]*m[7]*m[10];
    inv[4] = -m[4]*m[10]*m[15] + m[4]*m[11]*m[14] + m[8]*m[6]*m[15] - m[8]*m[7]*m[14] - m[12]*m[6]*m[11] + m[12]*m[7]*m[10];
    inv[8] = m[4]*m[9]*m[15] - m[4]*m[11]*m[13] - m[8]*m[5]*m[15] + m[8]*m[7]*m[13] + m[12]*m[5]*m[11] - m[12]*m[7]*m[9];
    inv[12] = -m[4]*m[9]*m[14] + m[4]*m[10]*m[13] + m[8]*m[5]*m[14] - m[8]*m[6]*m[13] - m[12]*m[5]*m[10] + m[12]*m[6]*m[9];
    inv[1] = -m[1]*m[10]*m[15] + m[1]*m[11]*m[14] + m[9]*m[2]*m[15] - m[9]*m[3]*m[14] - m[13]*m[2]*m[11] + m[13]*m[3]*m[10];
    inv[5] = m[0]*m[10]*m[15] - m[0]*m[11]*m[14] - m[8]*m[2]*m[15] + m[8]*m[3]*m[14] + m[12]*m[2]*m[11] - m[12]*m[3]*m[10];
    inv[9] = -m[0]*m[9]*m[15] + m[0]*m[11]*m[13] + m[8]*m[1]*m[15] - m[8]*m[3]*m[13] - m[12]*m[1]*m[11] + m[12]*m[3]*m[9];
    inv[13] = m[0]*m[9]*m[14] - m[0]*m[10]*m[13] - m[8]*m[1]*m[14] + m[8]*m[2]*m[13] + m[12]*m[1]*m[10] - m[12]*m[2]*m[9];
    inv[2] = m[1]*m[6]*m[15] - m[1]*m[7]*m[14] - m[5]*m[2]*m[15] + m[5]*m[3]*m[14] + m[13]*m[2]*m[7] - m[13]*m[3]*m[6];
    inv[6] = -m[0]*m[6]*m[15] + m[0]*m[7]*m[14] + m[4]*m[2]*m[15] - m[4]*m[3]*m[14] - m[12]*m[2]*m[7] + m[12]*m[3]*m[6];
    inv[10] = m[0]*m[5]*m[15] - m[0]*m[7]*m[13] - m[4]*m[1]*m[15] + m[4]*m[3]*m[13] + m[12]*m[1]*m[7] - m[12]*m[3]*m[5];
    inv[14] = -m[0]*m[5]*m[14] + m[0]*m[6]*m[13] + m[4]*m[1]*m[14] - m[4]*m[2]*m[13] - m[12]*m[1]*m[6] + m[12]*m[2]*m[5];
    inv[3] = -m[1]*m[6]*m[11] + m[1]*m[7]*m[10] + m[5]*m[2]*m[11] - m[5]*m[3]*m[10] - m[9]*m[2]*m[7] + m[9]*m[3]*m[6];
    inv[7] = m[0]*m[6]*m[11] - m[0]*m[7]*m[10] - m[4]*m[2]*m[11] + m[4]*m[3]*m[10] + m[8]*m[2]*m[7] - m[8]*m[3]*m[6];
    inv[11] = -m[0]*m[5]*m[11] + m[0]*m[7]*m[9] + m[4]*m[1]*m[11] - m[4]*m[3]*m[9] - m[8]*m[1]*m[7] + m[8]*m[3]*m[5];
    inv[15] = m[0]*m[5]*m[10] - m[0]*m[6]*m[9] - m[4]*m[1]*m[10] + m[4]*m[2]*m[9] + m[8]*m[1]*m[6] - m[8]*m[2]*m[5];

    let det = m[0]*inv[0] + m[1]*inv[4] + m[2]*inv[8] + m[3]*inv[12];
    if (Math.abs(det) < 1e-10) { out.fill(0); out[0] = out[5] = out[10] = out[15] = 1; return; }
    det = 1.0 / det;
    for (let i = 0; i < 16; i++) out[i] = inv[i] * det;
  }

  isReady(): boolean {
    return this.volumeReady;
  }

  /**
   * Compute a 4×4 rotation matrix from arcball drag.
   * prevPos/currPos are normalized device coordinates in [-1,1]².
   * Maps each 2D point onto a virtual sphere and computes the rotation
   * that takes prevPos to currPos.
   */
  static arcballRotation(prevX: number, prevY: number, currX: number, currY: number): Float32Array {
    const p = arcballProject(prevX, prevY);
    const q = arcballProject(currX, currY);
    const axis = new Float32Array(3);
    cross3(axis, q, p);
    let dot = dot3(p, q);
    if (dot > 1.0) dot = 1.0;
    if (dot < -1.0) dot = -1.0;
    const angle = Math.acos(dot);
    return axisAngleToMatrix(axis, angle);
  }

  destroy(): void {
    const gl = this.gl;
    if (!gl) return;
    if (this.program) gl.deleteProgram(this.program);
    if (this.volumeTexture) gl.deleteTexture(this.volumeTexture);
    if (this.tfTexture) gl.deleteTexture(this.tfTexture);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer);
    this.volumeReady = false;
  }
}

// --- Arcball helper functions ---

function arcballProject(x: number, y: number): Float32Array {
  const r = 1.0;
  const d = Math.sqrt(x * x + y * y);
  if (d < r * 0.7071067811865476) {
    // Inside sphere
    return new Float32Array([x, y, Math.sqrt(r * r - d * d)]);
  }
  // On hyperbola (outside sphere)
  const s = r * 0.7071067811865476;
  return new Float32Array([x, y, s * s / d]);
}

function dot3(a: Float32Array, b: Float32Array): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(out: Float32Array, a: Float32Array, b: Float32Array): void {
  const ax = a[0], ay = a[1], az = a[2];
  const bx = b[0], by = b[1], bz = b[2];
  out[0] = ay * bz - az * by;
  out[1] = az * bx - ax * bz;
  out[2] = ax * by - ay * bx;
}

function axisAngleToMatrix(axis: Float32Array, angle: number): Float32Array {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  const len = Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]);
  if (len < 1e-10) {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  }
  const x = axis[0] / len, y = axis[1] / len, z = axis[2] / len;
  const m = new Float32Array(16);
  m[0] = t * x * x + c;
  m[1] = t * x * y + s * z;
  m[2] = t * x * z - s * y;
  m[4] = t * x * y - s * z;
  m[5] = t * y * y + c;
  m[6] = t * y * z + s * x;
  m[8] = t * x * z + s * y;
  m[9] = t * y * z - s * x;
  m[10] = t * z * z + c;
  m[15] = 1;
  return m;
}
