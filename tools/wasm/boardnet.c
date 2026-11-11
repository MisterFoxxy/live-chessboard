// BoardNet kernels for WebAssembly SIMD (clang --target=wasm32 -msimd128).
// Buffers are planar float32 with a 1-pixel zero border: plane = (S+2)^2.
// Weights are packed per group of 4 output channels: pw[((g*C + c)*kk + t)*4 + j], bias pb[g*4 + j].
#include <wasm_simd128.h>
typedef float f32;

static void zero(f32 *p, int n) { for (int i = 0; i < n; i++) p[i] = 0.f; }

__attribute__((export_name("conv")))
void conv(const f32 *in, int C, int S, const f32 *pw, const f32 *pb, f32 *out, int O, int k, int relu) {
  const int P = S + 2, plane = P * P, G = (O + 3) / 4, kk = k * k;
  zero(out, O * plane);
  int offs[9];
  for (int t = 0; t < kk; t++) offs[t] = (k == 3) ? ((t / 3) - 1) * P + (t % 3 - 1) : 0;
  const v128_t zero4 = wasm_f32x4_splat(0.f);
  for (int g = 0; g < G; g++) {
    const v128_t bias = wasm_v128_load(pb + g * 4);
    const f32 *wg = pw + g * C * kk * 4;
    const int n = (O - g * 4) < 4 ? (O - g * 4) : 4;
    f32 *o = out + g * 4 * plane;
    for (int y = 1; y <= S; y++) {
      int x = 1;
      for (; x + 1 <= S; x += 2) {              // two pixels share every weight load
        const int pix = y * P + x;
        v128_t a = bias, b = bias;
        const f32 *w = wg;
        for (int c = 0; c < C; c++) {
          const f32 *base = in + c * plane + pix;
          if (kk == 9) {
#define TAP(t) { const v128_t wv = wasm_v128_load(w + 4 * (t)); \
                 a = wasm_f32x4_add(a, wasm_f32x4_mul(wv, wasm_f32x4_splat(base[offs[t]]))); \
                 b = wasm_f32x4_add(b, wasm_f32x4_mul(wv, wasm_f32x4_splat(base[offs[t] + 1]))); }
            TAP(0) TAP(1) TAP(2) TAP(3) TAP(4) TAP(5) TAP(6) TAP(7) TAP(8)
#undef TAP
            w += 36;
          } else {
            for (int t = 0; t < kk; t++, w += 4) {
              const v128_t wv = wasm_v128_load(w);
              a = wasm_f32x4_add(a, wasm_f32x4_mul(wv, wasm_f32x4_splat(base[offs[t]])));
              b = wasm_f32x4_add(b, wasm_f32x4_mul(wv, wasm_f32x4_splat(base[offs[t] + 1])));
            }
          }
        }
        if (relu) { a = wasm_f32x4_max(a, zero4); b = wasm_f32x4_max(b, zero4); }
        o[pix] = wasm_f32x4_extract_lane(a, 0); o[pix + 1] = wasm_f32x4_extract_lane(b, 0);
        if (n > 1) { o[plane + pix] = wasm_f32x4_extract_lane(a, 1); o[plane + pix + 1] = wasm_f32x4_extract_lane(b, 1); }
        if (n > 2) { o[2 * plane + pix] = wasm_f32x4_extract_lane(a, 2); o[2 * plane + pix + 1] = wasm_f32x4_extract_lane(b, 2); }
        if (n > 3) { o[3 * plane + pix] = wasm_f32x4_extract_lane(a, 3); o[3 * plane + pix + 1] = wasm_f32x4_extract_lane(b, 3); }
      }
      for (; x <= S; x++) {                        // odd width tail
        const int pix = y * P + x;
        v128_t a = bias;
        const f32 *w = wg;
        for (int c = 0; c < C; c++) {
          const f32 *base = in + c * plane + pix;
          for (int t = 0; t < kk; t++, w += 4)
            a = wasm_f32x4_add(a, wasm_f32x4_mul(wasm_v128_load(w), wasm_f32x4_splat(base[offs[t]])));
        }
        if (relu) a = wasm_f32x4_max(a, zero4);
        o[pix] = wasm_f32x4_extract_lane(a, 0);
        if (n > 1) o[plane + pix] = wasm_f32x4_extract_lane(a, 1);
        if (n > 2) o[2 * plane + pix] = wasm_f32x4_extract_lane(a, 2);
        if (n > 3) o[3 * plane + pix] = wasm_f32x4_extract_lane(a, 3);
      }
    }
  }
}

__attribute__((export_name("pool")))
void pool(const f32 *in, int C, int S, f32 *out) {
  const int P = S + 2, h = S >> 1, Q = h + 2;
  zero(out, C * Q * Q);
  for (int c = 0; c < C; c++) {
    const f32 *ib = in + c * P * P; f32 *ob = out + c * Q * Q;
    for (int y = 0; y < h; y++) {
      const f32 *r0 = ib + (2 * y + 1) * P + 1, *r1 = r0 + P; f32 *oi = ob + (y + 1) * Q + 1;
      for (int x = 0; x < h; x++) {
        f32 a = r0[2 * x], b = r0[2 * x + 1], cc = r1[2 * x], d = r1[2 * x + 1];
        f32 m = a > b ? a : b, m2 = cc > d ? cc : d;
        oi[x] = m > m2 ? m : m2;
      }
    }
  }
}
