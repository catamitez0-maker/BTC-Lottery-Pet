// SHA-256 double-hash Bitcoin mining kernel for OpenCL.
//
// Buffer layout (identical to the WGSL shader)
// =============
// params (read-only, 20 × uint):
//   [0..7]   = midstate        (8 × uint, big-endian SHA-256 state after first 64 header bytes)
//   [8..10]  = tail words      (3 × uint, header bytes 64-75 in LITTLE-endian native format)
//   [11]     = nonce_start     (uint)
//   [12..19] = share target    (8 × uint, big-endian, for hash comparison)
//
// results (read-write, 257 × uint, atomic):
//   [0]      = count of found nonces
//   [1..256] = found nonce values

#pragma OPENCL EXTENSION cl_khr_global_int32_base_atomics : enable

__constant uint K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
};

inline uint rotr(uint x, uint n) {
    return (x >> n) | (x << (32u - n));
}

inline uint swap_bytes(uint x) {
    return ((x & 0xffu) << 24u)
         | ((x & 0xff00u) << 8u)
         | ((x & 0xff0000u) >> 8u)
         | ((x & 0xff000000u) >> 24u);
}

void expand_schedule(uint w[64]) {
    for (int i = 16; i < 64; i++) {
        uint s0 = rotr(w[i - 15], 7u) ^ rotr(w[i - 15], 18u) ^ (w[i - 15] >> 3u);
        uint s1 = rotr(w[i - 2], 17u) ^ rotr(w[i - 2], 19u) ^ (w[i - 2] >> 10u);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
}

void sha256_compress(uint state[8], uint w[64]) {
    uint a = state[0];
    uint b = state[1];
    uint c = state[2];
    uint d = state[3];
    uint e = state[4];
    uint f = state[5];
    uint g = state[6];
    uint h = state[7];

    for (int i = 0; i < 64; i++) {
        uint s1 = rotr(e, 6u) ^ rotr(e, 11u) ^ rotr(e, 25u);
        uint ch = (e & f) ^ (~e & g);
        uint temp1 = h + s1 + ch + K[i] + w[i];
        uint s0 = rotr(a, 2u) ^ rotr(a, 13u) ^ rotr(a, 22u);
        uint maj = (a & b) ^ (a & c) ^ (b & c);
        uint temp2 = s0 + maj;

        h = g;
        g = f;
        f = e;
        e = d + temp1;
        d = c;
        c = b;
        b = a;
        a = temp1 + temp2;
    }

    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
    state[5] += f;
    state[6] += g;
    state[7] += h;
}

__kernel void sha256_mine(
    __global const uint* params,
    __global volatile uint* results
) {
    uint gid = get_global_id(0);
    uint nonce = params[11] + gid;

    // --- First SHA-256: complete block 2 starting from midstate ---
    uint state[8];
    state[0] = params[0];
    state[1] = params[1];
    state[2] = params[2];
    state[3] = params[3];
    state[4] = params[4];
    state[5] = params[5];
    state[6] = params[6];
    state[7] = params[7];

    // Build message schedule for block 2
    // W[0..2] = swap_bytes(tail[0..2]), W[3] = swap_bytes(nonce)
    // W[4] = 0x80000000 (padding bit), W[5..14] = 0, W[15] = 640 (80 * 8 bits)
    uint w1[64];
    w1[0] = swap_bytes(params[8]);
    w1[1] = swap_bytes(params[9]);
    w1[2] = swap_bytes(params[10]);
    w1[3] = swap_bytes(nonce);
    w1[4] = 0x80000000u;
    w1[5] = 0u;
    w1[6] = 0u;
    w1[7] = 0u;
    w1[8] = 0u;
    w1[9] = 0u;
    w1[10] = 0u;
    w1[11] = 0u;
    w1[12] = 0u;
    w1[13] = 0u;
    w1[14] = 0u;
    w1[15] = 640u;
    expand_schedule(w1);
    sha256_compress(state, w1);

    // --- Second SHA-256: hash the 32-byte first hash result ---
    uint w2[64];
    w2[0] = state[0];
    w2[1] = state[1];
    w2[2] = state[2];
    w2[3] = state[3];
    w2[4] = state[4];
    w2[5] = state[5];
    w2[6] = state[6];
    w2[7] = state[7];
    w2[8] = 0x80000000u;
    w2[9] = 0u;
    w2[10] = 0u;
    w2[11] = 0u;
    w2[12] = 0u;
    w2[13] = 0u;
    w2[14] = 0u;
    w2[15] = 256u;
    expand_schedule(w2);

    // Reset state to SHA-256 initial hash values
    state[0] = 0x6a09e667u;
    state[1] = 0xbb67ae85u;
    state[2] = 0x3c6ef372u;
    state[3] = 0xa54ff53au;
    state[4] = 0x510e527fu;
    state[5] = 0x9b05688cu;
    state[6] = 0x1f83d9abu;
    state[7] = 0x5be0cd19u;

    sha256_compress(state, w2);

    // --- Compare hash against target (both big-endian, MSB first) ---
    int is_valid = 1;
    for (int i = 0; i < 8; i++) {
        uint h_word = state[i];
        uint t = params[12 + i];
        if (h_word < t) {
            break;
        }
        if (h_word > t) {
            is_valid = 0;
            break;
        }
        // If equal, continue to next word
    }

    if (is_valid) {
        uint slot = atomic_inc(&results[0]);
        if (slot < 256u) {
            atomic_xchg(&results[1u + slot], nonce);
        }
    }
}
