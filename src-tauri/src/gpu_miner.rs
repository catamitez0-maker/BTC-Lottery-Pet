use std::sync::atomic::Ordering;
use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::miner::{self, log_message, ShareSubmission, SharedMiningState};

// OpenCL imports (all gated behind runtime availability checks)
use opencl3::command_queue::{CommandQueue, CL_QUEUE_PROFILING_ENABLE};
use opencl3::context::Context;
use opencl3::device::{Device, CL_DEVICE_TYPE_GPU};
use opencl3::kernel::{ExecuteKernel, Kernel};
use opencl3::memory::{Buffer, CL_MEM_READ_ONLY, CL_MEM_READ_WRITE};
use opencl3::platform::get_platforms;
use opencl3::program::Program;
use opencl3::types::{cl_uint, CL_BLOCKING};

// SHA-256 round constants
const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
    0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
    0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
    0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
    0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
    0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
];

// SHA-256 initial hash values
const H_INIT: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
    0x5be0cd19,
];

/// Computes the SHA-256 intermediate state after processing one 64-byte block.
/// Returns 8 big-endian u32 values representing the SHA-256 state.
pub(crate) fn sha256_midstate(first_block: &[u8; 64]) -> [u32; 8] {
    // Parse the 64-byte block into 16 big-endian u32 words
    let mut w = [0u32; 64];
    for i in 0..16 {
        w[i] = u32::from_be_bytes([
            first_block[i * 4],
            first_block[i * 4 + 1],
            first_block[i * 4 + 2],
            first_block[i * 4 + 3],
        ]);
    }

    // Expand message schedule
    for i in 16..64 {
        let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
        let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16]
            .wrapping_add(s0)
            .wrapping_add(w[i - 7])
            .wrapping_add(s1);
    }

    // Compress
    let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = H_INIT;

    for i in 0..64 {
        let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
        let ch = (e & f) ^ (!e & g);
        let temp1 = h
            .wrapping_add(s1)
            .wrapping_add(ch)
            .wrapping_add(K[i])
            .wrapping_add(w[i]);
        let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
        let maj = (a & b) ^ (a & c) ^ (b & c);
        let temp2 = s0.wrapping_add(maj);

        h = g;
        g = f;
        f = e;
        e = d.wrapping_add(temp1);
        d = c;
        c = b;
        b = a;
        a = temp1.wrapping_add(temp2);
    }

    [
        H_INIT[0].wrapping_add(a),
        H_INIT[1].wrapping_add(b),
        H_INIT[2].wrapping_add(c),
        H_INIT[3].wrapping_add(d),
        H_INIT[4].wrapping_add(e),
        H_INIT[5].wrapping_add(f),
        H_INIT[6].wrapping_add(g),
        H_INIT[7].wrapping_add(h),
    ]
}

/// Converts a share difficulty to an 8-word big-endian target for GPU comparison.
///
/// DIFF_ONE_TARGET = 0xFFFF * 2^208, represented as words: [0, 0xFFFF0000, 0, 0, 0, 0, 0, 0].
/// target = DIFF_ONE_TARGET / difficulty
pub(crate) fn difficulty_to_target_words(difficulty: f64) -> [u32; 8] {
    // For very low difficulty, return max target (any hash matches)
    if difficulty < 1.5e-5 {
        return [0xFFFFFFFF; 8];
    }

    // DIFF_ONE_TARGET as words is [0x00000000, 0xFFFF0000, 0x00000000, ...].
    // The mantissa at difficulty 1.0 is 0xFFFF, shifted left by 16 bits within
    // a 64-bit value that spans words[0] and words[1].
    //
    // mantissa = 65535.0 / difficulty
    // shifted = mantissa << 16
    // words[0] = shifted >> 32
    // words[1] = shifted as u32

    let mantissa = 65535.0 / difficulty;
    let shifted = (mantissa * 65536.0) as u64;

    let mut words = [0u32; 8];
    words[0] = (shifted >> 32) as u32;
    words[1] = shifted as u32;
    words
}

/// Information about an available GPU device.
pub(crate) struct GpuDeviceInfo {
    pub id: String,
    pub name: String,
    #[allow(dead_code)]
    pub device_type: String,
    #[allow(dead_code)]
    pub backend: String,
    pub simulated: bool,
}

/// Returns true if the given wgpu adapter is a software / CPU-emulated device
/// (e.g. Microsoft WARP on Windows) rather than a real hardware GPU.
fn is_wgpu_software_adapter(info: &wgpu::AdapterInfo) -> bool {
    matches!(
        info.device_type,
        wgpu::DeviceType::Cpu | wgpu::DeviceType::Other
    ) || info.name.to_ascii_lowercase().contains("warp")
      || info.name.to_ascii_lowercase().contains("software")
      || info.name.to_ascii_lowercase().contains("llvmpipe")
}

/// Enumerates available GPU devices using wgpu and OpenCL.
/// Always includes an "auto" entry first.
pub(crate) fn enumerate_gpu_devices() -> Vec<GpuDeviceInfo> {
    let mut devices = vec![GpuDeviceInfo {
        id: "auto".into(),
        name: "Auto (best available GPU)".into(),
        device_type: "auto".into(),
        backend: "auto".into(),
        simulated: false,
    }];

    // --- wgpu devices ---
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::all(),
        ..Default::default()
    });

    eprintln!("[GPU] Enumerating wgpu adapters...");
    let adapters = instance.enumerate_adapters(wgpu::Backends::all());
    eprintln!("[GPU] Found {} wgpu adapter(s)", adapters.len());
    for (index, adapter) in adapters.iter().enumerate() {
        let info = adapter.get_info();
        let simulated = is_wgpu_software_adapter(&info);
        eprintln!(
            "[GPU]   #{}: {} (type={:?}, backend={:?}, simulated={})",
            index, info.name, info.device_type, info.backend, simulated
        );
        devices.push(GpuDeviceInfo {
            id: format!("gpu-{index}"),
            name: format!("{} ({:?})", info.name, info.backend),
            device_type: format!("{:?}", info.device_type),
            backend: format!("{:?}", info.backend),
            simulated,
        });
    }

    // If enumerate_adapters found nothing, try request_adapter as fallback
    if adapters.is_empty() {
        eprintln!("[GPU] enumerate_adapters empty, trying request_adapter fallback...");
        if let Some(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None,
            force_fallback_adapter: false,
        })) {
            let info = adapter.get_info();
            let simulated = is_wgpu_software_adapter(&info);
            eprintln!(
                "[GPU]   Fallback found: {} (type={:?}, backend={:?}, simulated={})",
                info.name, info.device_type, info.backend, simulated
            );
            devices.push(GpuDeviceInfo {
                id: "gpu-0".into(),
                name: format!("{} ({:?})", info.name, info.backend),
                device_type: format!("{:?}", info.device_type),
                backend: format!("{:?}", info.backend),
                simulated,
            });
        } else {
            eprintln!("[GPU]   Fallback also found nothing.");
        }
    }

    // --- OpenCL devices ---
    eprintln!("[GPU] Enumerating OpenCL devices...");
    match enumerate_opencl_devices() {
        Ok(cl_devices) => {
            eprintln!("[GPU] Found {} OpenCL GPU device(s)", cl_devices.len());
            devices.extend(cl_devices);
        }
        Err(e) => {
            eprintln!("[GPU] OpenCL enumeration failed: {e}");
        }
    }

    devices
}

/// Enumerates OpenCL GPU devices across all platforms.
/// Returns a vec of GpuDeviceInfo with ids like "opencl-0-0", "opencl-0-1", etc.
fn enumerate_opencl_devices() -> Result<Vec<GpuDeviceInfo>, String> {
    let platforms = get_platforms().map_err(|e| format!("get_platforms: {e}"))?;
    let mut devices = Vec::new();

    for (plat_idx, platform) in platforms.iter().enumerate() {
        let plat_name = platform
            .name()
            .unwrap_or_else(|_| "Unknown Platform".into());

        let gpu_devices = platform
            .get_devices(CL_DEVICE_TYPE_GPU)
            .unwrap_or_default();

        for (dev_idx, &device_id) in gpu_devices.iter().enumerate() {
            let device = Device::new(device_id);
            let dev_name = device.name().unwrap_or_else(|_| "Unknown GPU".into());

            // Skip software / CPU-emulated OpenCL devices
            let lower = dev_name.to_ascii_lowercase();
            if lower.contains("cpu") || lower.contains("software") || lower.contains("pocl") {
                eprintln!("[GPU]   Skipping OpenCL software device: {dev_name}");
                continue;
            }

            eprintln!(
                "[GPU]   OpenCL {}-{}: {} (platform: {})",
                plat_idx, dev_idx, dev_name, plat_name
            );
            devices.push(GpuDeviceInfo {
                id: format!("opencl-{plat_idx}-{dev_idx}"),
                name: format!("{dev_name} (OpenCL)"),
                device_type: "DiscreteGpu".into(),
                backend: "OpenCL".into(),
                simulated: false,
            });
        }
    }

    Ok(devices)
}

/// The GPU miner holds a wgpu device, queue, compute pipeline, and pre-allocated
/// buffers needed to run SHA-256 mining batches on the GPU.
pub(crate) struct GpuMiner {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::ComputePipeline,
    _bind_group_layout: wgpu::BindGroupLayout,
    params_buffer: wgpu::Buffer,
    results_buffer: wgpu::Buffer,
    staging_buffer: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    batch_size: u32,
    device_name: String,
}

impl GpuMiner {
    /// Creates a new GPU miner. Selects the adapter by `device_id` (e.g. "gpu-0")
    /// or auto-selects the best available GPU if `device_id` is None or "auto".
    /// `intensity_percent` (1-100) controls the batch size from 1M to 16M nonces.
    ///
    /// In auto mode, software renderers like WARP are rejected so that
    /// `create_gpu_backend()` can fall back to OpenCL.
    pub(crate) fn new(device_id: Option<&str>, intensity_percent: u8) -> Result<Self, String> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::all(),
            ..Default::default()
        });

        let adapter = if let Some(id) = device_id.filter(|id| *id != "auto") {
            // Try to match by device_id like "gpu-0", "gpu-1", etc.
            let adapters = instance.enumerate_adapters(wgpu::Backends::all());
            let index: usize = id
                .strip_prefix("gpu-")
                .and_then(|n| n.parse().ok())
                .ok_or_else(|| format!("invalid GPU device id: {id}"))?;
            adapters
                .into_iter()
                .nth(index)
                .ok_or_else(|| format!("GPU device {id} not found"))?
        } else {
            // Auto-select: prefer high-performance GPU
            let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
            }))
            .ok_or_else(|| "no compatible GPU adapter found".to_string())?;

            // Reject software renderers (WARP, llvmpipe) in auto mode —
            // they are slower than CPU mining. Let create_gpu_backend fall back to OpenCL.
            let info = adapter.get_info();
            if is_wgpu_software_adapter(&info) {
                return Err(format!(
                    "auto-selected adapter '{}' is a software renderer, skipping",
                    info.name
                ));
            }
            adapter
        };

        let adapter_info = adapter.get_info();
        let device_name = adapter_info.name.clone();

        let (device, queue) = pollster::block_on(adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: Some("btc-lottery-gpu"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                memory_hints: wgpu::MemoryHints::Performance,
            },
            None,
        ))
        .map_err(|error| format!("failed to create GPU device: {error}"))?;

        let shader_source = include_str!("sha256_mining.wgsl");
        let shader_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("sha256_mining"),
            source: wgpu::ShaderSource::Wgsl(shader_source.into()),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("mining_bind_group_layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("mining_pipeline_layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("sha256_mining_pipeline"),
            layout: Some(&pipeline_layout),
            module: &shader_module,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });

        // Scale batch size from 1M (intensity 1%) to 4M (intensity 100%).
        // Round to a multiple of 256 (workgroup size). Capping at 4M prevents
        // Windows TDR (Timeout Detection and Recovery) on slower graphics cards.
        let intensity = intensity_percent.clamp(1, 100) as u32;
        let raw = (1_000_000 + (intensity - 1) * 30_303).min(4_000_000);
        let batch_size = (raw + 255) & !255; // round up to multiple of 256

        // Pre-allocate GPU buffers (reused across all mine_batch calls)
        let params_size = 20 * 4; // 20 u32s
        let results_size = 257 * 4; // 257 u32s

        let params_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("params"),
            size: params_size as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let results_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("results"),
            size: results_size as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let staging_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("staging"),
            size: results_size as u64,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("mining_bind_group"),
            layout: &bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: params_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: results_buffer.as_entire_binding(),
                },
            ],
        });

        Ok(Self {
            device,
            queue,
            pipeline,
            _bind_group_layout: bind_group_layout,
            params_buffer,
            results_buffer,
            staging_buffer,
            bind_group,
            batch_size,
            device_name,
        })
    }

    /// Dispatches a single mining batch on the GPU.
    ///
    /// Returns a vector of nonces whose double-SHA256 hash was <= the target.
    /// Reuses pre-allocated buffers for zero-allocation hot path.
    pub(crate) fn mine_batch(
        &self,
        midstate: &[u32; 8],
        tail: &[u32; 3],
        nonce_start: u32,
        target: &[u32; 8],
    ) -> Result<Vec<u32>, String> {
        // Write params into the pre-allocated buffer
        let mut params_data = [0u32; 20];
        params_data[0..8].copy_from_slice(midstate);
        params_data[8..11].copy_from_slice(tail);
        params_data[11] = nonce_start;
        params_data[12..20].copy_from_slice(target);
        self.queue.write_buffer(&self.params_buffer, 0, &u32_slice_to_bytes(&params_data));

        // Zero the results buffer via a clear command
        let results_size = 257 * 4;

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("mining_encoder"),
            });

        // Clear the results buffer to zero before compute
        encoder.clear_buffer(&self.results_buffer, 0, None);

        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("mining_pass"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind_group, &[]);
            pass.dispatch_workgroups(self.batch_size / 256, 1, 1);
        }

        encoder.copy_buffer_to_buffer(&self.results_buffer, 0, &self.staging_buffer, 0, results_size as u64);
        self.queue.submit(std::iter::once(encoder.finish()));

        // Wait for GPU to finish with timeout (prevents infinite hang on driver stall)
        let buffer_slice = self.staging_buffer.slice(..);
        let (sender, receiver) = std::sync::mpsc::channel();
        buffer_slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });

        // Poll with timeout instead of Maintain::Wait to prevent infinite blocking
        // when the GPU driver hangs (e.g., after Windows TDR reset).
        let poll_deadline = Instant::now() + Duration::from_secs(10);
        let mut gpu_done = false;
        while Instant::now() < poll_deadline {
            self.device.poll(wgpu::Maintain::Poll);
            match receiver.try_recv() {
                Ok(Ok(())) => { gpu_done = true; break; }
                Ok(Err(_)) => {
                    self.staging_buffer.unmap();
                    return Err("GPU mapping failed (device lost)".to_string());
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_micros(100));
                }
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    self.staging_buffer.unmap();
                    return Err("GPU callback channel disconnected".to_string());
                }
            }
        }

        if !gpu_done {
            // GPU didn't respond within timeout — driver is likely hung
            return Err("GPU timed out after 10s (driver may be hung or TDR occurred)".to_string());
        }

        let result = {
            let data = buffer_slice.get_mapped_range();
            let results = bytes_to_u32_vec(&data);
            let count = (results[0] as usize).min(256);
            let nonces = results[1..1 + count].to_vec();
            drop(data);
            Ok(nonces)
        };

        // Unmap the staging buffer so it can be reused next call
        self.staging_buffer.unmap();
        result
    }

    /// Returns the batch size (number of nonces per dispatch).
    pub(crate) fn batch_size(&self) -> u32 {
        self.batch_size
    }

    /// Returns the GPU device name.
    pub(crate) fn device_name(&self) -> &str {
        &self.device_name
    }
}

/// Safe conversion from &[u32] to a byte vector (native-endian).
fn u32_slice_to_bytes(data: &[u32]) -> Vec<u8> {
    data.iter().flat_map(|v| v.to_ne_bytes()).collect()
}

/// Safe conversion from &[u8] to Vec<u32> without UB.
/// Uses native-endian byte reading — no alignment requirement.
fn bytes_to_u32_vec(data: &[u8]) -> Vec<u32> {
    assert!(data.len() % 4 == 0, "byte slice length not a multiple of 4");
    data.chunks_exact(4)
        .map(|chunk| u32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}

// ---------------------------------------------------------------------------
// OpenCL miner
// ---------------------------------------------------------------------------

/// OpenCL-based GPU miner for older GPUs that don't support DX12/Vulkan.
/// Uses the same buffer layout and SHA-256 algorithm as the wgpu miner.
/// Buffers are pre-allocated and reused across mine_batch calls.
pub(crate) struct OpenClMiner {
    _context: Context,
    queue: CommandQueue,
    kernel: Kernel,
    params_buffer: Buffer<cl_uint>,
    results_buffer: Buffer<cl_uint>,
    batch_size: usize,
    device_name: String,
}

impl OpenClMiner {
    /// Creates a new OpenCL miner.
    ///
    /// `device_index` selects a specific device by `(platform_idx, device_idx)` pair.
    /// If `None`, auto-selects the first available GPU across all platforms.
    /// `intensity_percent` (1-100) controls batch size from 1M to 16M nonces.
    pub(crate) fn new(
        device_index: Option<(usize, usize)>,
        intensity_percent: u8,
    ) -> Result<Self, String> {
        let platforms = get_platforms().map_err(|e| format!("OpenCL get_platforms: {e}"))?;
        if platforms.is_empty() {
            return Err("no OpenCL platforms found".into());
        }

        // Find the requested device, or auto-select the first GPU
        let (device, dev_name) = if let Some((plat_idx, dev_idx)) = device_index {
            let platform = platforms
                .get(plat_idx)
                .ok_or_else(|| format!("OpenCL platform {plat_idx} not found"))?;
            let gpu_devices = platform
                .get_devices(CL_DEVICE_TYPE_GPU)
                .map_err(|e| format!("OpenCL get_devices: {e}"))?;
            let &raw_id = gpu_devices
                .get(dev_idx)
                .ok_or_else(|| format!("OpenCL device {plat_idx}-{dev_idx} not found"))?;
            let device = Device::new(raw_id);
            let name = device.name().unwrap_or_else(|_| "Unknown GPU".into());
            (device, name)
        } else {
            // Auto: first GPU on any platform
            let mut found = None;
            for platform in &platforms {
                if let Ok(gpu_devices) = platform.get_devices(CL_DEVICE_TYPE_GPU) {
                    if let Some(&raw_id) = gpu_devices.first() {
                        let device = Device::new(raw_id);
                        let name = device.name().unwrap_or_else(|_| "Unknown GPU".into());
                        found = Some((device, name));
                        break;
                    }
                }
            }
            found.ok_or_else(|| "no OpenCL GPU devices found".to_string())?
        };

        let context = Context::from_device(&device)
            .map_err(|e| format!("OpenCL context creation failed: {e}"))?;

        let queue = CommandQueue::create_default_with_properties(
            &context,
            CL_QUEUE_PROFILING_ENABLE,
            0,
        )
        .map_err(|e| format!("OpenCL command queue creation failed: {e}"))?;

        let kernel_source = include_str!("sha256_mining.cl");
        let program = Program::create_and_build_from_source(&context, kernel_source, "")
            .map_err(|e| format!("OpenCL program build failed: {e}"))?;

        let kernel = Kernel::create(&program, "sha256_mine")
            .map_err(|e| format!("OpenCL kernel creation failed: {e}"))?;

        // Scale batch size from 1M (intensity 1%) to 4M (intensity 100%).
        // Round to a multiple of 256 (workgroup size). Capping at 4M prevents
        // Windows TDR (Timeout Detection and Recovery) on slower graphics cards.
        let intensity = intensity_percent.clamp(1, 100) as usize;
        let raw = (1_000_000 + (intensity - 1) * 30_303).min(4_000_000);
        let batch_size = (raw + 255) & !255;

        // Pre-allocate OpenCL buffers (reused across all mine_batch calls)
        let params_buffer = unsafe {
            Buffer::<cl_uint>::create(
                &context,
                CL_MEM_READ_ONLY,
                20,
                std::ptr::null_mut(),
            )
        }
        .map_err(|e| format!("OpenCL params buffer creation failed: {e}"))?;

        let results_buffer = unsafe {
            Buffer::<cl_uint>::create(
                &context,
                CL_MEM_READ_WRITE,
                257,
                std::ptr::null_mut(),
            )
        }
        .map_err(|e| format!("OpenCL results buffer creation failed: {e}"))?;

        eprintln!(
            "[OpenCL] Initialized: {} (batch_size={})",
            dev_name, batch_size
        );

        Ok(Self {
            _context: context,
            queue,
            kernel,
            params_buffer,
            results_buffer,
            batch_size,
            device_name: dev_name,
        })
    }

    /// Dispatches a single mining batch on the GPU via OpenCL.
    ///
    /// Returns a vector of nonces whose double-SHA256 hash was <= the target.
    /// Reuses pre-allocated buffers for minimal per-batch overhead.
    pub(crate) fn mine_batch(
        &mut self,
        midstate: &[u32; 8],
        tail: &[u32; 3],
        nonce_start: u32,
        target: &[u32; 8],
    ) -> Result<Vec<u32>, String> {
        // Build params data: 8 midstate + 3 tail + 1 nonce_start + 8 target = 20 u32s
        let mut params_data: [cl_uint; 20] = [0; 20];
        params_data[0..8].copy_from_slice(midstate);
        params_data[8..11].copy_from_slice(tail);
        params_data[11] = nonce_start;
        params_data[12..20].copy_from_slice(target);

        // Write params into the pre-allocated buffer
        let write_result = unsafe {
            self.queue.enqueue_write_buffer(
                &mut self.params_buffer,
                CL_BLOCKING,
                0,
                &params_data,
                &[],
            )
        };
        if let Err(e) = write_result {
            return Err(format!("OpenCL write params failed: {e}"));
        }

        // Zero the results buffer
        let zero_data: [cl_uint; 257] = [0; 257];
        let zero_result = unsafe {
            self.queue.enqueue_write_buffer(
                &mut self.results_buffer,
                CL_BLOCKING,
                0,
                &zero_data,
                &[],
            )
        };
        if let Err(e) = zero_result {
            return Err(format!("OpenCL zero results failed: {e}"));
        }

        // Execute kernel
        let kernel_event = unsafe {
            ExecuteKernel::new(&self.kernel)
                .set_arg(&self.params_buffer)
                .set_arg(&self.results_buffer)
                .set_global_work_size(self.batch_size)
                .set_local_work_size(256)
                .enqueue_nd_range(&self.queue)
        };
        if let Err(e) = kernel_event {
            return Err(format!("OpenCL kernel execute failed: {e}"));
        }

        // Read results back
        let mut results_data: [cl_uint; 257] = [0; 257];
        let read_result = unsafe {
            self.queue.enqueue_read_buffer(
                &self.results_buffer,
                CL_BLOCKING,
                0,
                &mut results_data,
                &[],
            )
        };
        if let Err(e) = read_result {
            return Err(format!("OpenCL read buffer failed: {e}"));
        }

        let count = (results_data[0] as usize).min(256);
        Ok(results_data[1..1 + count].to_vec())
    }

    /// Returns the batch size (number of nonces per dispatch).
    pub(crate) fn batch_size(&self) -> u32 {
        self.batch_size as u32
    }

    /// Returns the GPU device name.
    pub(crate) fn device_name(&self) -> &str {
        &self.device_name
    }
}

// ---------------------------------------------------------------------------
// Unified GPU backend
// ---------------------------------------------------------------------------

/// Unified GPU backend that wraps either a wgpu or OpenCL miner.
pub(crate) enum GpuBackend {
    Wgpu(GpuMiner),
    OpenCl(OpenClMiner),
}

impl GpuBackend {
    /// Dispatches a mining batch on whichever backend is active.
    pub(crate) fn mine_batch(
        &mut self,
        midstate: &[u32; 8],
        tail: &[u32; 3],
        nonce_start: u32,
        target: &[u32; 8],
    ) -> Result<Vec<u32>, String> {
        match self {
            GpuBackend::Wgpu(gpu) => gpu.mine_batch(midstate, tail, nonce_start, target),
            GpuBackend::OpenCl(cl) => cl.mine_batch(midstate, tail, nonce_start, target),
        }
    }

    /// Returns the batch size (number of nonces per dispatch).
    pub(crate) fn batch_size(&self) -> u32 {
        match self {
            GpuBackend::Wgpu(gpu) => gpu.batch_size(),
            GpuBackend::OpenCl(cl) => cl.batch_size(),
        }
    }

    /// Returns the GPU device name.
    pub(crate) fn device_name(&self) -> &str {
        match self {
            GpuBackend::Wgpu(gpu) => gpu.device_name(),
            GpuBackend::OpenCl(cl) => cl.device_name(),
        }
    }

    /// Returns a short label for logging which backend is in use.
    pub(crate) fn backend_label(&self) -> &'static str {
        match self {
            GpuBackend::Wgpu(_) => "wgpu",
            GpuBackend::OpenCl(_) => "OpenCL",
        }
    }
}

/// Creates a GPU backend, selecting the appropriate technology.
///
/// Selection logic:
/// - device_id starting with "opencl-" → OpenCL directly
/// - device_id starting with "gpu-" or "auto" or None → try wgpu first, fall back to OpenCL
pub(crate) fn create_gpu_backend(
    device_id: Option<&str>,
    intensity_percent: u8,
) -> Result<GpuBackend, String> {
    let id = device_id.unwrap_or("auto");

    // If explicitly requesting OpenCL, use it directly
    if id.starts_with("opencl-") {
        let parts: Vec<&str> = id.split('-').collect();
        if parts.len() != 3 {
            return Err(format!("invalid OpenCL device id: {id}"));
        }
        let plat_idx: usize = parts[1]
            .parse()
            .map_err(|_| format!("invalid platform index in: {id}"))?;
        let dev_idx: usize = parts[2]
            .parse()
            .map_err(|_| format!("invalid device index in: {id}"))?;

        let cl = OpenClMiner::new(Some((plat_idx, dev_idx)), intensity_percent)?;
        return Ok(GpuBackend::OpenCl(cl));
    }

    // Try wgpu first
    match GpuMiner::new(device_id, intensity_percent) {
        Ok(gpu) => {
            eprintln!(
                "[GPU] Using wgpu backend: {} (batch_size={})",
                gpu.device_name(),
                gpu.batch_size()
            );
            return Ok(GpuBackend::Wgpu(gpu));
        }
        Err(wgpu_err) => {
            eprintln!("[GPU] wgpu init failed: {wgpu_err}, trying OpenCL fallback...");
        }
    }

    // Fall back to OpenCL
    match OpenClMiner::new(None, intensity_percent) {
        Ok(cl) => {
            eprintln!(
                "[GPU] Using OpenCL fallback: {} (batch_size={})",
                cl.device_name(),
                cl.batch_size()
            );
            Ok(GpuBackend::OpenCl(cl))
        }
        Err(cl_err) => Err(format!(
            "no GPU backend available — wgpu: {wgpu_err}, OpenCL: {cl_err}",
            wgpu_err = "see above",
            cl_err = cl_err
        )),
    }
}



/// Main GPU hashing loop. Runs in a dedicated thread.
///
/// This is the GPU equivalent of `hash_loop` in miner.rs. It continuously pulls
/// the latest job from shared state, dispatches GPU batches, verifies found
/// nonces on the CPU, and submits shares.
pub(crate) fn gpu_hash_loop(
    shared: Arc<SharedMiningState>,
    share_sender: SyncSender<ShareSubmission>,
    app: AppHandle,
    pool: String,
    gpu_device_id: Option<String>,
    gpu_intensity_percent: u8,
    worker_index: usize,
    total_workers: usize,
) {
    let mut gpu = match create_gpu_backend(gpu_device_id.as_deref(), gpu_intensity_percent) {
        Ok(gpu) => {
            log_message(
                &app,
                &format!(
                    "GPU miner initialized [{}]: {} (batch_size={})",
                    gpu.backend_label(),
                    gpu.device_name(),
                    gpu.batch_size()
                ),
            );
            gpu
        }
        Err(error) => {
            log_message(&app, &format!("GPU init failed: {error}"));
            return;
        }
    };

    while !shared.stop.load(Ordering::Acquire) {
        let Some(job) = shared.job.read().unwrap().clone() else {
            std::thread::sleep(Duration::from_millis(25));
            continue;
        };

        // Target only depends on share_difficulty which is constant for a job.
        let target = difficulty_to_target_words(job.share_difficulty);

        let mut extranonce_counter = worker_index as u64 + 1;
        let mut extranonce_cycles = 0u64;

        while !shared.stop.load(Ordering::Acquire)
            && shared.job_generation.load(Ordering::Acquire) == job.generation
        {
            let extranonce2 = miner::extranonce2_hex(extranonce_counter, job.extranonce2_size);
            let Ok(header) = miner::build_header(&job, &extranonce2) else {
                shared.set_connection_status("Invalid pool job");
                shared.clear_job();
                break;
            };

            // Compute midstate from the first 64 bytes of the header.
            // This changes per-extranonce because extranonce2 is part of the coinbase
            // which feeds into the merkle root in the first 64 header bytes.
            let first_block: [u8; 64] = header[0..64].try_into().unwrap();
            let midstate = sha256_midstate(&first_block);

            // Extract tail from header bytes 64-75 as 3 little-endian u32 values
            let tail = [
                u32::from_le_bytes(header[64..68].try_into().unwrap()),
                u32::from_le_bytes(header[68..72].try_into().unwrap()),
                u32::from_le_bytes(header[72..76].try_into().unwrap()),
            ];

            // Inner nonce loop with adaptive batch sizing.
            //
            // Instead of a fixed batch_size that may exceed Windows TDR (2s)
            // on slow GPUs, we start conservative and dynamically adjust to
            // keep each dispatch in the 200-500ms sweet spot.
            let mut nonce_start = 0u32;
            let max_batch = gpu.batch_size();          // upper bound from intensity
            let min_batch: u32 = 256 * 64;             // 16K — minimum useful work
            let mut adaptive_batch = min_batch.max(max_batch / 16); // start at ~1/16 of max

            loop {
                if shared.stop.load(Ordering::Acquire)
                    || shared.job_generation.load(Ordering::Acquire) != job.generation
                {
                    break;
                }

                let dispatch_start = Instant::now();
                let found_nonces = match gpu.mine_batch(&midstate, &tail, nonce_start, &target) {
                    Ok(nonces) => nonces,
                    Err(err) => {
                        log_message(
                            &app,
                            &format!("GPU mining error: {err}. Attempting to re-initialize GPU in 3 seconds..."),
                        );
                        std::thread::sleep(Duration::from_secs(3));
                        match create_gpu_backend(gpu_device_id.as_deref(), gpu_intensity_percent) {
                            Ok(new_gpu) => {
                                gpu = new_gpu;
                                adaptive_batch = min_batch; // reset to conservative
                                log_message(&app, "GPU re-initialized successfully. Resuming mining.");
                                continue; // retry this batch
                            }
                            Err(reinit_err) => {
                                log_message(&app, &format!("GPU re-initialization failed: {reinit_err}"));
                                return;
                            }
                        }
                    }
                };
                let dispatch_ms = dispatch_start.elapsed().as_millis() as u64;

                // Track hash count
                shared
                    .hashes
                    .fetch_add(adaptive_batch as u64, Ordering::Relaxed);

                // Adaptive batch sizing: target 200-500ms per dispatch.
                // - Under 100ms → double (GPU can handle more)
                // - Over 800ms → halve (approaching TDR danger zone)
                // - 200-500ms → keep steady (sweet spot)
                if dispatch_ms < 100 {
                    adaptive_batch = (adaptive_batch.saturating_mul(2)).min(max_batch);
                } else if dispatch_ms > 800 {
                    adaptive_batch = (adaptive_batch / 2).max(min_batch);
                }
                // Round to workgroup size
                adaptive_batch = (adaptive_batch + 255) & !255;

                // Verify each found nonce on the CPU
                for &nonce in &found_nonces {
                    let mut verify_header = header.clone();
                    verify_header[76..80].copy_from_slice(&nonce.to_le_bytes());
                    let hash = miner::double_sha256(&verify_header);
                    let difficulty = miner::difficulty_from_hash(&hash);

                    shared.update_best_difficulty(difficulty);

                    if miner::hash_meets_network_target(&hash, &job.network_target) {
                        let event = miner::found_block_event(
                            &job,
                            nonce,
                            &extranonce2,
                            &hash,
                            difficulty,
                            &pool,
                        );
                        miner::record_block_candidate(&app, &event);
                    }

                    if difficulty >= job.share_difficulty {
                        if shared.stop.load(Ordering::Acquire) {
                            break;
                        }

                        log_message(
                            &app,
                            &format!(
                                "GPU found share: nonce={:08x}, diff={:.6}",
                                nonce, difficulty
                            ),
                        );

                        let submission = ShareSubmission {
                            job_id: job.job_id.clone(),
                            extranonce2: extranonce2.clone(),
                            ntime: job.ntime.clone(),
                            nonce,
                        };

                        match share_sender.try_send(submission) {
                            Ok(()) | Err(TrySendError::Full(_)) => {}
                            Err(TrySendError::Disconnected(_)) => return,
                        }
                    }
                }

                // Advance nonce_start; wrap on overflow means we've exhausted the space
                let next_nonce = match nonce_start.checked_add(adaptive_batch) {
                    Some(next) => next,
                    None => break, // exhausted nonce space
                };
                nonce_start = next_nonce;

                // Yield briefly when dispatches are very fast to prevent GPU
                // monopolization.  When dispatches are >= 100ms, the GPU driver
                // already had time to service display requests.
                if dispatch_ms < 100 {
                    std::thread::sleep(Duration::from_millis(1));
                }
            }

            extranonce_counter = extranonce_counter.wrapping_add(total_workers as u64);
            extranonce_cycles += 1;

            // Log diagnostic info periodically (every 10 extranonce cycles)
            if extranonce_cycles % 10 == 0 {
                log_message(
                    &app,
                    &format!(
                        "GPU extranonce cycle #{} (counter={})",
                        extranonce_cycles, extranonce_counter
                    ),
                );
            }
        }
    }
}

/// Result of a GPU benchmark run.
pub(crate) struct GpuBenchmarkInfo {
    pub device_name: String,
    pub hashrate: f64,
    pub duration_ms: u64,
    pub simulated: bool,
    pub note: String,
}

/// Runs a GPU mining benchmark for ~3 seconds with a dummy header.
/// Returns the measured hashrate and device information.
/// Tries wgpu first; falls back to OpenCL if wgpu is unavailable.
pub(crate) fn run_gpu_benchmark(
    device_id: Option<&str>,
    intensity_percent: u8,
) -> Result<GpuBenchmarkInfo, String> {
    let mut gpu = create_gpu_backend(device_id, intensity_percent)?;

    // Dummy header (80 bytes of zeros is fine for benchmarking)
    let first_block = [0u8; 64];
    let midstate = sha256_midstate(&first_block);
    let tail = [0u32; 3];
    let target = [0u32; 8]; // impossibly hard target — we don't care about matches

    let benchmark_duration = Duration::from_secs(3);
    let start = Instant::now();
    let mut total_hashes = 0u64;
    let mut nonce_start = 0u32;

    while start.elapsed() < benchmark_duration {
        // Use catch_unwind to survive driver crashes from old/buggy GPU drivers
        let batch_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            gpu.mine_batch(&midstate, &tail, nonce_start, &target)
        }));

        match batch_result {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => {
                return Err(format!("GPU benchmark error: {e}"));
            }
            Err(_) => {
                return Err("GPU driver crashed during benchmark (possible driver incompatibility)".into());
            }
        }

        total_hashes += gpu.batch_size() as u64;
        match nonce_start.checked_add(gpu.batch_size()) {
            Some(next) => nonce_start = next,
            None => break,
        }
    }

    let elapsed = start.elapsed();
    let hashrate = total_hashes as f64 / elapsed.as_secs_f64();

    Ok(GpuBenchmarkInfo {
        device_name: gpu.device_name().to_owned(),
        hashrate,
        duration_ms: elapsed.as_millis() as u64,
        simulated: false,
        note: format!(
            "Real GPU benchmark [{}] on {}. {} hashes in {:.1}s.",
            gpu.backend_label(),
            gpu.device_name(),
            total_hashes,
            elapsed.as_secs_f64()
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_midstate_matches_known_vector() {
        // Test with a block of 64 zero bytes.
        // The SHA-256 midstate for a block of 64 zero bytes is the compression
        // of that block starting from H_INIT. We verify against a known result
        // computed by a reference implementation.
        let block = [0u8; 64];
        let midstate = sha256_midstate(&block);

        // Known SHA-256 midstate for 64 zero bytes:
        // This is SHA-256 compress(H_INIT, parse_block(0x00 * 64))
        let expected: [u32; 8] = [
            0xda5698be, 0x17b9b469, 0x62335799, 0x779fbeca,
            0x8ce5d491, 0xc0d26243, 0xbafef9ea, 0x1837a9d8,
        ];
        assert_eq!(midstate, expected);
    }

    #[test]
    fn difficulty_to_target_preserves_diff_one() {
        let target = difficulty_to_target_words(1.0);
        assert_eq!(target, [0, 0xFFFF0000, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn difficulty_to_target_low_diff_is_max() {
        let target = difficulty_to_target_words(1e-10);
        assert_eq!(target, [0xFFFFFFFF; 8]);
    }

    #[test]
    fn gpu_device_enumeration_includes_auto() {
        let devices = enumerate_gpu_devices();
        assert!(!devices.is_empty());
        assert_eq!(devices[0].id, "auto");
        assert!(!devices[0].simulated);
    }

    #[test]
    fn opencl_device_enumeration_works() {
        // This should not crash even if no OpenCL devices are available.
        // On systems with OpenCL, it will list GPU devices; on systems
        // without, it will return an empty vec or an error.
        let result = enumerate_opencl_devices();
        match result {
            Ok(devices) => {
                eprintln!("OpenCL enumeration found {} device(s)", devices.len());
                for d in &devices {
                    assert!(d.id.starts_with("opencl-"));
                    assert!(d.name.contains("(OpenCL)"));
                    assert_eq!(d.backend, "OpenCL");
                }
            }
            Err(e) => {
                eprintln!("OpenCL not available (expected on some systems): {e}");
            }
        }
    }
}
