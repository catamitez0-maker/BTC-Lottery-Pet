// SHA-256 double-hash Bitcoin mining compute shader.
//
// Buffer layout
// =============
// params (storage, read):
//   [0..7]   = midstate        (8 × u32, big-endian SHA-256 state after first 64 header bytes)
//   [8..10]  = tail words      (3 × u32, header bytes 64-75 in LITTLE-endian native format)
//   [11]     = nonce_start     (u32)
//   [12..19] = share target    (8 × u32, big-endian, for hash comparison)
//
// results (storage, read_write, atomic):
//   [0]      = count of found nonces
//   [1..256] = found nonce values

@group(0) @binding(0) var<storage, read> params: array<u32>;
@group(0) @binding(1) var<storage, read_write> results: array<atomic<u32>>;

// SHA-256 round constants
const K: array<u32, 64> = array<u32, 64>(
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u,
    0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
    0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
    0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
    0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
    0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u,
    0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u,
    0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
);

fn rotr(x: u32, n: u32) -> u32 {
    return (x >> n) | (x << (32u - n));
}

fn swap_bytes(x: u32) -> u32 {
    return ((x & 0xffu) << 24u)
         | ((x & 0xff00u) << 8u)
         | ((x & 0xff0000u) >> 8u)
         | ((x & 0xff000000u) >> 24u);
}

// Expand a 16-word message schedule to 64 words (in-place via pointer).
fn expand_schedule(w: ptr<function, array<u32, 64>>) {
    for (var i = 16u; i < 64u; i = i + 1u) {
        let s0 = rotr((*w)[i - 15u], 7u) ^ rotr((*w)[i - 15u], 18u) ^ ((*w)[i - 15u] >> 3u);
        let s1 = rotr((*w)[i - 2u], 17u) ^ rotr((*w)[i - 2u], 19u) ^ ((*w)[i - 2u] >> 10u);
        (*w)[i] = (*w)[i - 16u] + s0 + (*w)[i - 7u] + s1;
    }
}

// SHA-256 compression: state is modified in-place via pointer.
// The caller must pre-expand the message schedule to 64 words.
fn sha256_compress(state: ptr<function, array<u32, 8>>, w: ptr<function, array<u32, 64>>) {
    var a = (*state)[0];
    var b = (*state)[1];
    var c = (*state)[2];
    var d = (*state)[3];
    var e = (*state)[4];
    var f = (*state)[5];
    var g = (*state)[6];
    var h = (*state)[7];

    for (var i = 0u; i < 64u; i = i + 1u) {
        let s1 = rotr(e, 6u) ^ rotr(e, 11u) ^ rotr(e, 25u);
        let ch = (e & f) ^ (~e & g);
        let temp1 = h + s1 + ch + K[i] + (*w)[i];
        let s0 = rotr(a, 2u) ^ rotr(a, 13u) ^ rotr(a, 22u);
        let maj = (a & b) ^ (a & c) ^ (b & c);
        let temp2 = s0 + maj;

        h = g;
        g = f;
        f = e;
        e = d + temp1;
        d = c;
        c = b;
        b = a;
        a = temp1 + temp2;
    }

    (*state)[0] = (*state)[0] + a;
    (*state)[1] = (*state)[1] + b;
    (*state)[2] = (*state)[2] + c;
    (*state)[3] = (*state)[3] + d;
    (*state)[4] = (*state)[4] + e;
    (*state)[5] = (*state)[5] + f;
    (*state)[6] = (*state)[6] + g;
    (*state)[7] = (*state)[7] + h;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let nonce = params[11] + gid.x;

    // --- First SHA-256: complete block 2 starting from midstate ---
    var state: array<u32, 8>;
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
    var w1: array<u32, 64>;
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
    expand_schedule(&w1);
    sha256_compress(&state, &w1);

    // --- Second SHA-256: hash the 32-byte first hash result ---
    // state[] now holds the first hash (big-endian u32 words).
    // Save it, then reset state to SHA-256 IV for the second pass.
    var w2: array<u32, 64>;
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
    expand_schedule(&w2);

    // Reset state to SHA-256 initial hash values
    state[0] = 0x6a09e667u;
    state[1] = 0xbb67ae85u;
    state[2] = 0x3c6ef372u;
    state[3] = 0xa54ff53au;
    state[4] = 0x510e527fu;
    state[5] = 0x9b05688cu;
    state[6] = 0x1f83d9abu;
    state[7] = 0x5be0cd19u;

    sha256_compress(&state, &w2);

    // --- Compare hash against target (both big-endian, MSB first) ---
    let target_offset = 12u;
    var is_valid = true;
    for (var i = 0u; i < 8u; i = i + 1u) {
        let h = state[i];
        let t = params[target_offset + i];
        if h < t {
            break;
        }
        if h > t {
            is_valid = false;
            break;
        }
        // If equal, continue to next word
    }

    if is_valid {
        let slot = atomicAdd(&results[0], 1u);
        if slot < 256u {
            atomicStore(&results[1u + slot], nonce);
        }
    }
}
