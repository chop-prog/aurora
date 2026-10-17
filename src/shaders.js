// GLSL ES 3.00 sources for a GPU "stable fluids" solver (Jos Stam, 1999) with
// vorticity confinement. Each pass is a full-screen quad rendering into a texture.

const HEADER = `#version 300 es
precision highp float;
precision highp sampler2D;
`;

export const baseVertex = `${HEADER}
in vec2 aPosition;
out vec2 vUv;
out vec2 vL;
out vec2 vR;
out vec2 vT;
out vec2 vB;
uniform vec2 texelSize;
void main () {
  vUv = aPosition * 0.5 + 0.5;
  vL = vUv - vec2(texelSize.x, 0.0);
  vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y);
  vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const frag = (body) => `${HEADER}
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
out vec4 fragColor;
${body}`;

export const copyShader = frag(`
uniform sampler2D uTexture;
void main () { fragColor = texture(uTexture, vUv); }`);

export const clearShader = frag(`
uniform sampler2D uTexture;
uniform float value;
void main () { fragColor = value * texture(uTexture, vUv); }`);

// Gaussian "splat" of dye or velocity around a point.
export const splatShader = frag(`
uniform sampler2D uTarget;
uniform float aspectRatio;
uniform vec3 color;
uniform vec2 point;
uniform float radius;
void main () {
  vec2 p = vUv - point;
  p.x *= aspectRatio;
  vec3 splat = exp(-dot(p, p) / radius) * color;
  fragColor = vec4(texture(uTarget, vUv).xyz + splat, 1.0);
}`);

// Semi-Lagrangian advection: trace each cell backwards along the velocity field.
export const advectionShader = frag(`
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 texelSize;
uniform float dt;
uniform float dissipation;
void main () {
  vec2 coord = vUv - dt * texture(uVelocity, vUv).xy * texelSize;
  fragColor = texture(uSource, coord) / (1.0 + dissipation * dt);
}`);

export const divergenceShader = frag(`
uniform sampler2D uVelocity;
void main () {
  float L = texture(uVelocity, vL).x;
  float R = texture(uVelocity, vR).x;
  float T = texture(uVelocity, vT).y;
  float B = texture(uVelocity, vB).y;
  vec2 C = texture(uVelocity, vUv).xy;
  // Reflective walls: mirror velocity at the borders.
  if (vL.x < 0.0) L = -C.x;
  if (vR.x > 1.0) R = -C.x;
  if (vT.y > 1.0) T = -C.y;
  if (vB.y < 0.0) B = -C.y;
  fragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`);

export const curlShader = frag(`
uniform sampler2D uVelocity;
void main () {
  float L = texture(uVelocity, vL).y;
  float R = texture(uVelocity, vR).y;
  float T = texture(uVelocity, vT).x;
  float B = texture(uVelocity, vB).x;
  fragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`);

// Vorticity confinement re-injects the small swirls numerical diffusion smears away.
export const vorticityShader = frag(`
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float curl;
uniform float dt;
void main () {
  float L = texture(uCurl, vL).x;
  float R = texture(uCurl, vR).x;
  float T = texture(uCurl, vT).x;
  float B = texture(uCurl, vB).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= curl * C;
  force.y *= -1.0;
  vec2 velocity = texture(uVelocity, vUv).xy + force * dt;
  fragColor = vec4(clamp(velocity, -1000.0, 1000.0), 0.0, 1.0);
}`);

// One Jacobi iteration of the pressure Poisson equation.
export const pressureShader = frag(`
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main () {
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  float divergence = texture(uDivergence, vUv).x;
  fragColor = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0);
}`);

// Projection: subtract the pressure gradient → divergence-free (incompressible) flow.
export const gradientSubtractShader = frag(`
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main () {
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  vec2 velocity = texture(uVelocity, vUv).xy - vec2(R - L, T - B);
  fragColor = vec4(velocity, 0.0, 1.0);
}`);

// Final composite. Mode 0 = dye with fake lighting, 1-3 = debug views of the solver's fields.
export const displayShader = frag(`
uniform sampler2D uTexture;
uniform vec2 texelSize;
uniform float shading;
uniform int mode;
uniform vec3 background;
vec3 diverging (float x) {
  x = clamp(x, -1.0, 1.0);
  return x > 0.0 ? mix(vec3(0.02), vec3(1.0, 0.45, 0.2), x) : mix(vec3(0.02), vec3(0.2, 0.6, 1.0), -x);
}
void main () {
  vec4 s = texture(uTexture, vUv);
  vec3 c;
  if (mode == 1) {
    c = vec3(abs(s.x), abs(s.y), 0.25 * length(s.xy)) * 0.004;
  } else if (mode == 2) {
    c = diverging(s.x * 0.03);
  } else if (mode == 3) {
    c = diverging(s.x * 0.02);
  } else {
    c = s.rgb;
    if (shading > 0.0) {
      vec3 lc = texture(uTexture, vL).rgb;
      vec3 rc = texture(uTexture, vR).rgb;
      vec3 tc = texture(uTexture, vT).rgb;
      vec3 bc = texture(uTexture, vB).rgb;
      vec3 n = normalize(vec3(length(rc) - length(lc), length(tc) - length(bc), length(texelSize)));
      float diffuse = clamp(dot(n, vec3(0.0, 0.0, 1.0)) + 0.7, 0.7, 1.0);
      c *= mix(1.0, diffuse, shading);
    }
    c = 1.0 - exp(-c * 2.2); // filmic-ish tone map keeps bright overlaps from clipping
    c += background * (1.0 - max(c.r, max(c.g, c.b)));
  }
  // Ordered dither hides banding in the dark gradients.
  float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) / 255.0;
  fragColor = vec4(c + dither, 1.0);
}`);
