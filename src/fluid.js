// GPU fluid solver on raw WebGL2. Owns all textures/framebuffers and runs one
// simulation step per frame: curl → vorticity → divergence → pressure (Jacobi) →
// projection → advection of velocity and dye.

import * as S from './shaders.js';

class Program {
  constructor(gl, vertex, fragment) {
    this.gl = gl;
    this.program = gl.createProgram();
    gl.attachShader(this.program, compile(gl, gl.VERTEX_SHADER, vertex));
    gl.attachShader(this.program, compile(gl, gl.FRAGMENT_SHADER, fragment));
    gl.bindAttribLocation(this.program, 0, 'aPosition');
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program));
    this.u = {};
    const n = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(this.program, i).name;
      this.u[name] = gl.getUniformLocation(this.program, name);
    }
  }
  bind() {
    this.gl.useProgram(this.program);
    return this.u;
  }
}

function compile(gl, type, source) {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export class FluidSim {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
      throw new Error('This GPU cannot render to floating-point textures.');
    }
    this.gl = gl;
    this.formats = this._pickFormats();

    const p = (f) => new Program(gl, S.baseVertex, f);
    this.programs = {
      copy: p(S.copyShader),
      clear: p(S.clearShader),
      splat: p(S.splatShader),
      advection: p(S.advectionShader),
      divergence: p(S.divergenceShader),
      curl: p(S.curlShader),
      vorticity: p(S.vorticityShader),
      pressure: p(S.pressureShader),
      gradient: p(S.gradientSubtractShader),
      display: p(S.displayShader),
    };

    // Full-screen quad shared by every pass.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    this.simResolution = 128;
    this.dyeResolution = Math.min(1024, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    this.pressureDecay = 0.8;
    this.resize(true);
  }

  _pickFormats() {
    const gl = this.gl;
    const type = gl.HALF_FLOAT;
    const supports = (internal, format) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, 4, 4, 0, format, type, null);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      return ok;
    };
    const rgba = { internal: gl.RGBA16F, format: gl.RGBA, type };
    const rg = supports(gl.RG16F, gl.RG) ? { internal: gl.RG16F, format: gl.RG, type } : rgba;
    const r = supports(gl.R16F, gl.RED) ? { internal: gl.R16F, format: gl.RED, type } : rg;
    return { rgba, rg, r };
  }

  _fbo(w, h, fmt) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, w, h, 0, fmt.format, fmt.type, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      texture, fbo, width: w, height: h, texelX: 1 / w, texelY: 1 / h,
      attach(id) {
        gl.activeTexture(gl.TEXTURE0 + id);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return id;
      },
      dispose() {
        gl.deleteTexture(texture);
        gl.deleteFramebuffer(fbo);
      },
    };
  }

  _double(w, h, fmt) {
    let a = this._fbo(w, h, fmt);
    let b = this._fbo(w, h, fmt);
    return {
      width: w, height: h, texelX: 1 / w, texelY: 1 / h,
      get read() { return a; },
      get write() { return b; },
      swap() { [a, b] = [b, a]; },
      dispose() { a.dispose(); b.dispose(); },
    };
  }

  /** Re-create a double buffer at a new size, carrying the old contents over. */
  _resizeDouble(old, w, h, fmt) {
    if (old && old.width === w && old.height === h) return old;
    const next = this._double(w, h, fmt);
    if (old) {
      const u = this.programs.copy.bind();
      this.gl.uniform1i(u.uTexture, old.read.attach(0));
      this._blit(next.write);
      next.swap();
      old.dispose();
    }
    return next;
  }

  _size(resolution) {
    const gl = this.gl;
    const aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
    const a = aspect < 1 ? 1 / aspect : aspect;
    const min = Math.round(resolution);
    const max = Math.round(resolution * a);
    return gl.drawingBufferWidth > gl.drawingBufferHeight ? [max, min] : [min, max];
  }

  /** Match the canvas to its CSS size and (re)allocate simulation buffers. */
  resize(force = false) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (!force && w === this.canvas.width && h === this.canvas.height) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.allocate();
  }

  allocate() {
    const { rgba, rg, r } = this.formats;
    const [sw, sh] = this._size(this.simResolution);
    const [dw, dh] = this._size(this.dyeResolution);
    this.velocity = this._resizeDouble(this.velocity, sw, sh, rg);
    this.dye = this._resizeDouble(this.dye, dw, dh, rgba);
    for (const k of ['divergence', 'curl']) {
      if (this[k]) this[k].dispose();
      this[k] = this._fbo(sw, sh, r);
    }
    if (this.pressure) this.pressure.dispose();
    this.pressure = this._double(sw, sh, r);
  }

  setDyeResolution(res) {
    if (res === this.dyeResolution) return;
    this.dyeResolution = res;
    this.allocate();
  }

  _blit(target) {
    const gl = this.gl;
    if (target) {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    } else {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  /**
   * Inject velocity + dye. x, y in [0,1] (y up); dx, dy are velocity in sim texels/s.
   */
  splat(x, y, dx, dy, color, radius) {
    const gl = this.gl;
    const aspect = this.canvas.width / this.canvas.height;
    const r = (radius / 100) * (aspect > 1 ? aspect : 1);
    const u = this.programs.splat.bind();
    gl.uniform1f(u.aspectRatio, aspect);
    gl.uniform2f(u.point, x, y);
    gl.uniform1f(u.radius, r);
    gl.uniform2f(u.texelSize, this.velocity.texelX, this.velocity.texelY);

    gl.uniform1i(u.uTarget, this.velocity.read.attach(0));
    gl.uniform3f(u.color, dx, dy, 0);
    this._blit(this.velocity.write);
    this.velocity.swap();

    gl.uniform1i(u.uTarget, this.dye.read.attach(0));
    gl.uniform3f(u.color, color[0], color[1], color[2]);
    this._blit(this.dye.write);
    this.dye.swap();
  }

  step(dt, cfg) {
    const gl = this.gl;
    const P = this.programs;
    const vel = this.velocity;
    gl.disable(gl.BLEND);
    let u;

    u = P.curl.bind();
    gl.uniform2f(u.texelSize, vel.texelX, vel.texelY);
    gl.uniform1i(u.uVelocity, vel.read.attach(0));
    this._blit(this.curl);

    u = P.vorticity.bind();
    gl.uniform2f(u.texelSize, vel.texelX, vel.texelY);
    gl.uniform1i(u.uVelocity, vel.read.attach(0));
    gl.uniform1i(u.uCurl, this.curl.attach(1));
    gl.uniform1f(u.curl, cfg.curl);
    gl.uniform1f(u.dt, dt);
    this._blit(vel.write);
    vel.swap();

    u = P.divergence.bind();
    gl.uniform2f(u.texelSize, vel.texelX, vel.texelY);
    gl.uniform1i(u.uVelocity, vel.read.attach(0));
    this._blit(this.divergence);

    u = P.clear.bind();
    gl.uniform1i(u.uTexture, this.pressure.read.attach(0));
    gl.uniform1f(u.value, this.pressureDecay);
    this._blit(this.pressure.write);
    this.pressure.swap();

    u = P.pressure.bind();
    gl.uniform2f(u.texelSize, vel.texelX, vel.texelY);
    gl.uniform1i(u.uDivergence, this.divergence.attach(0));
    for (let i = 0; i < cfg.pressureIterations; i++) {
      gl.uniform1i(u.uPressure, this.pressure.read.attach(1));
      this._blit(this.pressure.write);
      this.pressure.swap();
    }

    u = P.gradient.bind();
    gl.uniform2f(u.texelSize, vel.texelX, vel.texelY);
    gl.uniform1i(u.uPressure, this.pressure.read.attach(0));
    gl.uniform1i(u.uVelocity, vel.read.attach(1));
    this._blit(vel.write);
    vel.swap();

    u = P.advection.bind();
    gl.uniform2f(u.texelSize, vel.texelX, vel.texelY);
    const id = vel.read.attach(0);
    gl.uniform1i(u.uVelocity, id);
    gl.uniform1i(u.uSource, id);
    gl.uniform1f(u.dt, dt);
    gl.uniform1f(u.dissipation, cfg.velocityDissipation);
    this._blit(vel.write);
    vel.swap();

    gl.uniform1i(u.uVelocity, vel.read.attach(0));
    gl.uniform1i(u.uSource, this.dye.read.attach(1));
    gl.uniform1f(u.dissipation, cfg.densityDissipation);
    this._blit(this.dye.write);
    this.dye.swap();
  }

  render(cfg) {
    const gl = this.gl;
    const modes = { dye: 0, velocity: 1, pressure: 2, curl: 3 };
    const mode = modes[cfg.display] ?? 0;
    const src = mode === 1 ? this.velocity.read : mode === 2 ? this.pressure.read : mode === 3 ? this.curl : this.dye.read;
    const u = this.programs.display.bind();
    gl.uniform2f(u.texelSize, 1 / src.width, 1 / src.height);
    gl.uniform1i(u.uTexture, src.attach(0));
    gl.uniform1f(u.shading, cfg.shading ? 1 : 0);
    gl.uniform1i(u.mode, mode);
    gl.uniform3f(u.background, 0.008, 0.01, 0.025);
    this._blit(null);
  }

  /** Zero every field. */
  clear() {
    const u = this.programs.clear.bind();
    this.gl.uniform1f(u.value, 0);
    for (const d of [this.velocity, this.dye, this.pressure]) {
      this.gl.uniform1i(u.uTexture, d.read.attach(0));
      this._blit(d.write);
      d.swap();
    }
  }

  get stats() {
    return { sim: `${this.velocity.width}×${this.velocity.height}`, dye: `${this.dye.width}×${this.dye.height}` };
  }
}
