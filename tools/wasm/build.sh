#!/bin/sh
# Rebuild the WebAssembly SIMD kernels and print base64 for js/board-net.js (WASM_B64)
cd "$(dirname "$0")"
clang --target=wasm32 -O3 -msimd128 -nostdlib -fno-builtin -Wl,--no-entry -Wl,--import-memory -Wl,--export=__heap_base -o boardnet.wasm boardnet.c
base64 -w0 boardnet.wasm > boardnet.wasm.b64
