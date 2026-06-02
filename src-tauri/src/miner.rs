use std::{
    collections::HashSet,
    io::{self, BufRead, BufReader, ErrorKind, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    str::FromStr,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc, Mutex, RwLock,
    },
    thread,
    time::{Duration, Instant},
};

use bitcoin::{Address, Network};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

const DIFF_ONE_TARGET: f64 =
    26_959_535_291_011_309_493_156_476_344_723_991_336_010_898_738_574_164_086_137_773_096_960.0;
const MAX_STRATUM_LINE_BYTES: usize = 1024 * 1024;
const MAX_EXTRANONCE2_BYTES: usize = 16;
const MAX_PENDING_SUBMISSIONS: usize = 128;
const MAX_SHARE_SUBMISSIONS_PER_TICK: usize = 16;
const SHARE_QUEUE_CAPACITY: usize = 256;
const MIN_SHARE_DIFFICULTY: f64 = 1e-12;
const STATS_EVENT: &str = "mining-stats";

fn log_message(app: &AppHandle, message: &str) {
    use std::fs::OpenOptions;
    use std::io::Write;

    let _ = app.emit("mining-log", message);

    let log_dir = match app.path().app_log_dir() {
        Ok(dir) => dir,
        Err(_) => return,
    };

    if let Err(_) = std::fs::create_dir_all(&log_dir) {
        return;
    }

    let log_file_path = log_dir.join("mining.log");

    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    let log_line = format!("[{}] {}\n", now, message);

    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file_path)
    {
        let _ = file.write_all(log_line.as_bytes());
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealMiningSettings {
    pub pool_host: String,
    pub pool_port: u16,
    pub btc_address: String,
    pub worker_name: String,
    pub cpu_threads: usize,
    pub confirmed_cpu_use: bool,
}

impl RealMiningSettings {
    fn validate(&self) -> Result<(), String> {
        if !self.confirmed_cpu_use {
            return Err("real mining requires an explicit CPU-use confirmation".into());
        }

        if self.pool_host.is_empty()
            || self.pool_host.chars().any(char::is_whitespace)
            || self.pool_host.contains("://")
            || self.pool_host.contains('/')
        {
            return Err("pool host must be a hostname without a URL scheme or path".into());
        }

        if self.pool_port == 0 {
            return Err("pool port must be greater than zero".into());
        }

        validate_mainnet_address(self.btc_address.trim())?;

        if self.worker_name.is_empty()
            || self
                .worker_name
                .chars()
                .any(|character| !(character.is_ascii_alphanumeric() || "-_".contains(character)))
        {
            return Err(
                "worker name may contain only letters, numbers, dashes, and underscores".into(),
            );
        }

        let available_threads = thread::available_parallelism()
            .map(|count| count.get())
            .unwrap_or(1);

        if self.cpu_threads == 0 || self.cpu_threads > available_threads {
            return Err(format!(
                "CPU threads must be between 1 and {available_threads} on this computer"
            ));
        }

        Ok(())
    }

    fn username(&self) -> String {
        format!("{}.{}", self.btc_address.trim(), self.worker_name)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct MiningStats {
    pub hashrate: f64,
    pub accepted_shares: u64,
    pub rejected_shares: u64,
    pub best_difficulty: f64,
    pub current_job_id: String,
    pub connection_status: String,
}

impl MiningStats {
    fn stopped() -> Self {
        Self {
            hashrate: 0.0,
            accepted_shares: 0,
            rejected_shares: 0,
            best_difficulty: 0.0,
            current_job_id: String::new(),
            connection_status: "Stopped".into(),
        }
    }
}

#[derive(Default)]
pub struct MiningController {
    stop_signal: Mutex<Option<Arc<AtomicBool>>>,
}

impl MiningController {
    pub fn start(&self, app: AppHandle, settings: RealMiningSettings) -> Result<(), String> {
        settings.validate()?;
        self.stop(&app);

        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let worker_app = app.clone();

        thread::Builder::new()
            .name("btc-lottery-stratum".into())
            .spawn(move || run_miner(worker_app, settings, worker_stop))
            .map_err(|error| format!("failed to start Stratum worker: {error}"))?;

        *self.stop_signal.lock().unwrap() = Some(stop);
        Ok(())
    }

    pub fn stop(&self, app: &AppHandle) {
        if let Some(stop) = self.stop_signal.lock().unwrap().take() {
            stop.store(true, Ordering::Release);
        }

        let _ = app.emit(STATS_EVENT, MiningStats::stopped());
    }
}

#[derive(Clone)]
struct JobTemplate {
    generation: u64,
    job_id: String,
    prev_hash: String,
    coinbase1: String,
    coinbase2: String,
    merkle_branches: Vec<String>,
    version: String,
    nbits: String,
    ntime: String,
    extranonce1: String,
    extranonce2_size: usize,
    share_difficulty: f64,
}

struct SharedMiningState {
    stop: Arc<AtomicBool>,
    job: RwLock<Option<JobTemplate>>,
    job_generation: AtomicU64,
    hashes: AtomicU64,
    accepted_shares: AtomicU64,
    rejected_shares: AtomicU64,
    best_difficulty_bits: AtomicU64,
    connection_status: Mutex<String>,
}

impl SharedMiningState {
    fn new(stop: Arc<AtomicBool>) -> Self {
        Self {
            stop,
            job: RwLock::new(None),
            job_generation: AtomicU64::new(0),
            hashes: AtomicU64::new(0),
            accepted_shares: AtomicU64::new(0),
            rejected_shares: AtomicU64::new(0),
            best_difficulty_bits: AtomicU64::new(0.0_f64.to_bits()),
            connection_status: Mutex::new("Starting".into()),
        }
    }

    fn set_connection_status(&self, status: impl Into<String>) {
        *self.connection_status.lock().unwrap() = status.into();
    }

    fn set_job(&self, mut job: JobTemplate) {
        job.generation = self.job_generation.fetch_add(1, Ordering::AcqRel) + 1;
        *self.job.write().unwrap() = Some(job);
    }

    fn clear_job(&self) {
        self.job_generation.fetch_add(1, Ordering::AcqRel);
        *self.job.write().unwrap() = None;
    }

    fn update_best_difficulty(&self, difficulty: f64) {
        let mut current = self.best_difficulty_bits.load(Ordering::Relaxed);

        while difficulty > f64::from_bits(current) {
            match self.best_difficulty_bits.compare_exchange_weak(
                current,
                difficulty.to_bits(),
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(updated) => current = updated,
            }
        }
    }

    fn snapshot(&self, hashrate: f64) -> MiningStats {
        let current_job_id = self
            .job
            .read()
            .unwrap()
            .as_ref()
            .map(|job| job.job_id.clone())
            .unwrap_or_default();

        MiningStats {
            hashrate,
            accepted_shares: self.accepted_shares.load(Ordering::Relaxed),
            rejected_shares: self.rejected_shares.load(Ordering::Relaxed),
            best_difficulty: f64::from_bits(self.best_difficulty_bits.load(Ordering::Relaxed)),
            current_job_id,
            connection_status: self.connection_status.lock().unwrap().clone(),
        }
    }
}

#[derive(Clone)]
struct ShareSubmission {
    job_id: String,
    extranonce2: String,
    ntime: String,
    nonce: u32,
}

#[derive(Default)]
struct ProtocolState {
    extranonce1: Option<String>,
    extranonce2_size: Option<usize>,
    difficulty: f64,
}

fn run_miner(app: AppHandle, settings: RealMiningSettings, stop: Arc<AtomicBool>) {
    let shared = Arc::new(SharedMiningState::new(Arc::clone(&stop)));
    let (share_sender, share_receiver) = mpsc::sync_channel(SHARE_QUEUE_CAPACITY);
    let workers = spawn_hash_workers(&settings, &shared, &share_sender);

    while !stop.load(Ordering::Acquire) {
        shared.set_connection_status("Connecting");
        log_message(&app, &format!("Connecting to {}:{}", settings.pool_host, settings.pool_port));
        emit_stats(&app, &shared, 0.0);

        if let Err(error) = run_stratum_connection(&app, &settings, &shared, &share_receiver) {
            if stop.load(Ordering::Acquire) {
                break;
            }

            shared.clear_job();
            shared.set_connection_status(format!("Retrying: {error}"));
            log_message(&app, &format!("Connection error: {}. Retrying in 2s...", error));
            emit_stats(&app, &shared, 0.0);
            sleep_until_stopped(&stop, Duration::from_secs(2));
        }
    }

    stop.store(true, Ordering::Release);
    for worker in workers {
        let _ = worker.join();
    }

    shared.clear_job();
    shared.set_connection_status("Stopped");
    log_message(&app, "Mining stopped");
    emit_stats(&app, &shared, 0.0);
}

fn run_stratum_connection(
    app: &AppHandle,
    settings: &RealMiningSettings,
    shared: &Arc<SharedMiningState>,
    share_receiver: &Receiver<ShareSubmission>,
) -> Result<(), String> {
    let address = format!("{}:{}", settings.pool_host, settings.pool_port);
    let socket_addresses = address
        .to_socket_addrs()
        .map_err(|error| format!("DNS failed for {}: {error}", settings.pool_host))?
        .collect::<Vec<_>>();
    let mut stream = connect_to_pool(&address, &socket_addresses)?;
    log_message(app, "Connected to pool");

    stream
        .set_read_timeout(Some(Duration::from_millis(200)))
        .map_err(|error| format!("failed to set socket read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| format!("failed to set socket write timeout: {error}"))?;

    let reader_stream = stream
        .try_clone()
        .map_err(|error| format!("failed to initialize socket reader: {error}"))?;
    let mut reader = BufReader::new(reader_stream);
    let username = settings.username();
    let mut protocol = ProtocolState {
        difficulty: 1.0,
        ..ProtocolState::default()
    };
    let mut pending_submissions = HashSet::new();
    let mut request_id = 10_u64;
    let mut last_report = Instant::now();
    let mut last_hash_count = shared.hashes.load(Ordering::Relaxed);

    shared.set_connection_status("Subscribing");
    log_message(app, &format!("Subscribing to pool with worker: {}", username));
    while share_receiver.try_recv().is_ok() {}
    write_message(
        &mut stream,
        &json!({
            "id": 1,
            "method": "mining.subscribe",
            "params": ["BTC Lottery Pet/0.2.0"]
        }),
    )?;
    write_message(
        &mut stream,
        &json!({
            "id": 2,
            "method": "mining.authorize",
            "params": [username, "x"]
        }),
    )?;

    let mut last_job_received = Instant::now();
    let mut debug_hint_logged = false;

    while !shared.stop.load(Ordering::Acquire) {
        let has_job = shared.job.read().unwrap().is_some();
        if has_job {
            last_job_received = Instant::now();
            debug_hint_logged = false;
        } else if !debug_hint_logged && last_job_received.elapsed() >= Duration::from_secs(20) {
            log_message(app, "[Warning] No jobs received yet. Verify your pool address, port, BTC address, and network firewall settings.");
            debug_hint_logged = true;
        }

        for _ in 0..submission_budget(pending_submissions.len()) {
            let Ok(share) = share_receiver.try_recv() else {
                break;
            };

            request_id += 1;
            log_message(app, &format!("Share submitted: job_id={}, nonce={:08x}", share.job_id, share.nonce));
            write_message(
                &mut stream,
                &json!({
                    "id": request_id,
                    "method": "mining.submit",
                    "params": [
                        username,
                        share.job_id,
                        share.extranonce2,
                        share.ntime,
                        format!("{:08x}", share.nonce)
                    ]
                }),
            )?;
            pending_submissions.insert(request_id);
        }

        match read_stratum_line(&mut reader) {
            Ok(None) => return Err("pool closed the connection".into()),
            Ok(Some(line)) => {
                handle_server_message(
                    app,
                    line.trim(),
                    &mut protocol,
                    shared,
                    &mut pending_submissions,
                )?;
            }
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(error) => return Err(format!("socket read failed: {error}")),
        }

        if last_report.elapsed() >= Duration::from_secs(1) {
            let elapsed = last_report.elapsed().as_secs_f64();
            let current_hash_count = shared.hashes.load(Ordering::Relaxed);
            let hashrate = current_hash_count.saturating_sub(last_hash_count) as f64 / elapsed;
            emit_stats(app, shared, hashrate);
            last_hash_count = current_hash_count;
            last_report = Instant::now();
        }
    }

    Ok(())
}

fn handle_server_message(
    app: &AppHandle,
    line: &str,
    protocol: &mut ProtocolState,
    shared: &Arc<SharedMiningState>,
    pending_submissions: &mut HashSet<u64>,
) -> Result<(), String> {
    if line.is_empty() {
        return Ok(());
    }

    let message: Value =
        serde_json::from_str(line).map_err(|error| format!("invalid Stratum JSON: {error}"))?;

    if let Some(method) = message.get("method").and_then(Value::as_str) {
        match method {
            "mining.set_difficulty" => {
                let difficulty = value_as_f64(&message["params"][0])
                    .ok_or_else(|| "pool sent an invalid share difficulty".to_string())?;
                protocol.difficulty = validate_share_difficulty(difficulty)?;
            }
            "mining.set_extranonce" => {
                protocol.extranonce1 = message["params"][0].as_str().map(str::to_owned);
                protocol.extranonce2_size = message["params"][1]
                    .as_u64()
                    .map(|size| validate_extranonce2_size(size as usize))
                    .transpose()?;
                shared.clear_job();
            }
            "mining.notify" => {
                if let Some(job) = parse_job(message.get("params"), protocol)? {
                    let job_id = job.job_id.clone();
                    let diff = job.share_difficulty;
                    shared.set_job(job);
                    shared.set_connection_status("Mining");
                    log_message(app, &format!("Job received: id={}, diff={}", job_id, diff));
                }
            }
            _ => {}
        }

        return Ok(());
    }

    let Some(id) = message.get("id").and_then(Value::as_u64) else {
        return Ok(());
    };

    if id == 1 {
        let result = message
            .get("result")
            .and_then(Value::as_array)
            .ok_or_else(|| "pool rejected mining.subscribe".to_string())?;
        protocol.extranonce1 = result.get(1).and_then(Value::as_str).map(str::to_owned);
        protocol.extranonce2_size = result
            .get(2)
            .and_then(Value::as_u64)
            .map(|size| validate_extranonce2_size(size as usize))
            .transpose()?;

        if protocol.extranonce1.is_none() || protocol.extranonce2_size.is_none() {
            return Err("pool returned an incomplete mining.subscribe response".into());
        }

        shared.set_connection_status("Authorizing");
        log_message(app, "Subscribed to pool. Authorizing...");
    } else if id == 2 {
        if message.get("result").and_then(Value::as_bool) != Some(true) {
            return Err("pool rejected mining.authorize".into());
        }

        shared.set_connection_status("Authorized");
        log_message(app, "Worker authorized successfully");
    } else if pending_submissions.remove(&id) {
        if message.get("result").and_then(Value::as_bool) == Some(true) {
            shared.accepted_shares.fetch_add(1, Ordering::Relaxed);
            log_message(app, "Share accepted!");
        } else {
            shared.rejected_shares.fetch_add(1, Ordering::Relaxed);
            let err_str = message.get("error").map(|e| e.to_string()).unwrap_or_else(|| "unknown error".to_string());
            log_message(app, &format!("Share rejected. Reason: {}", err_str));
        }
    }

    Ok(())
}

fn parse_job(
    params: Option<&Value>,
    protocol: &ProtocolState,
) -> Result<Option<JobTemplate>, String> {
    let Some(params) = params.and_then(Value::as_array) else {
        return Err("pool sent mining.notify without params".into());
    };

    if params.len() < 9 {
        return Err("pool sent an incomplete mining.notify job".into());
    }

    let Some(extranonce1) = protocol.extranonce1.clone() else {
        return Ok(None);
    };
    let Some(extranonce2_size) = protocol.extranonce2_size else {
        return Ok(None);
    };

    let merkle_branches = params[4]
        .as_array()
        .ok_or_else(|| "pool sent invalid merkle branches".to_string())?
        .iter()
        .map(|branch| {
            branch
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| "pool sent a non-string merkle branch".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;

    if merkle_branches.len() > 64 {
        return Err("pool sent too many merkle branches".into());
    }

    Ok(Some(JobTemplate {
        generation: 0,
        job_id: required_string(params, 0, "job id")?,
        prev_hash: required_string(params, 1, "previous hash")?,
        coinbase1: required_string(params, 2, "coinbase prefix")?,
        coinbase2: required_string(params, 3, "coinbase suffix")?,
        merkle_branches,
        version: required_string(params, 5, "version")?,
        nbits: required_string(params, 6, "nbits")?,
        ntime: required_string(params, 7, "ntime")?,
        extranonce1,
        extranonce2_size,
        share_difficulty: validate_share_difficulty(protocol.difficulty)?,
    }))
}

fn connect_to_pool(
    address: &str,
    socket_addresses: &[std::net::SocketAddr],
) -> Result<TcpStream, String> {
    if socket_addresses.is_empty() {
        return Err(format!("no address found for {address}"));
    }

    let mut failures = Vec::new();
    for socket_address in socket_addresses {
        match TcpStream::connect_timeout(socket_address, Duration::from_secs(4)) {
            Ok(stream) => return Ok(stream),
            Err(error) => failures.push(format!("{socket_address}: {error}")),
        }
    }

    Err(format!(
        "could not connect to {address}: {}",
        failures.join("; ")
    ))
}

fn read_stratum_line(reader: &mut impl BufRead) -> io::Result<Option<String>> {
    let mut line = String::new();
    let bytes_read = reader
        .take((MAX_STRATUM_LINE_BYTES + 1) as u64)
        .read_line(&mut line)?;

    if bytes_read == 0 {
        return Ok(None);
    }

    if line.len() > MAX_STRATUM_LINE_BYTES {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "pool sent an oversized Stratum message",
        ));
    }

    Ok(Some(line))
}

fn required_string(params: &[Value], index: usize, label: &str) -> Result<String, String> {
    params[index]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("pool sent invalid {label}"))
}

fn value_as_f64(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|number| number.parse().ok()))
}

fn validate_mainnet_address(value: &str) -> Result<(), String> {
    Address::from_str(value)
        .map_err(|_| "enter a valid mainnet BTC address before starting real mining".to_string())?
        .require_network(Network::Bitcoin)
        .map_err(|_| "enter a valid mainnet BTC address before starting real mining".to_string())?;

    Ok(())
}

fn validate_share_difficulty(difficulty: f64) -> Result<f64, String> {
    if !difficulty.is_finite() || difficulty < MIN_SHARE_DIFFICULTY {
        return Err("pool sent an unsupported share difficulty".into());
    }

    Ok(difficulty)
}

fn submission_budget(pending_submissions: usize) -> usize {
    MAX_SHARE_SUBMISSIONS_PER_TICK.min(MAX_PENDING_SUBMISSIONS.saturating_sub(pending_submissions))
}

fn validate_extranonce2_size(size: usize) -> Result<usize, String> {
    if size == 0 || size > MAX_EXTRANONCE2_BYTES {
        return Err(format!(
            "pool sent an unsupported extranonce2 size of {size} bytes"
        ));
    }

    Ok(size)
}

fn spawn_hash_workers(
    settings: &RealMiningSettings,
    shared: &Arc<SharedMiningState>,
    share_sender: &SyncSender<ShareSubmission>,
) -> Vec<thread::JoinHandle<()>> {
    (0..settings.cpu_threads)
        .map(|worker_index| {
            let shared = Arc::clone(shared);
            let share_sender = share_sender.clone();
            let worker_count = settings.cpu_threads;

            thread::Builder::new()
                .name(format!("btc-lottery-hash-{worker_index}"))
                .spawn(move || hash_loop(worker_index, worker_count, shared, share_sender))
                .expect("failed to start hash worker")
        })
        .collect()
}

fn hash_loop(
    worker_index: usize,
    worker_count: usize,
    shared: Arc<SharedMiningState>,
    share_sender: SyncSender<ShareSubmission>,
) {
    while !shared.stop.load(Ordering::Acquire) {
        let Some(job) = shared.job.read().unwrap().clone() else {
            thread::sleep(Duration::from_millis(25));
            continue;
        };

        let mut extranonce_counter = worker_index as u64 + 1;

        while !shared.stop.load(Ordering::Acquire)
            && shared.job_generation.load(Ordering::Acquire) == job.generation
        {
            let extranonce2 = extranonce2_hex(extranonce_counter, job.extranonce2_size);
            let Ok(mut header) = build_header(&job, &extranonce2) else {
                shared.set_connection_status("Invalid pool job");
                shared.clear_job();
                break;
            };

            for nonce in 0..=u32::MAX {
                if shared.stop.load(Ordering::Acquire)
                    || shared.job_generation.load(Ordering::Acquire) != job.generation
                {
                    break;
                }

                header[76..80].copy_from_slice(&nonce.to_le_bytes());
                let hash = double_sha256(&header);
                let difficulty = difficulty_from_hash(&hash);
                shared.hashes.fetch_add(1, Ordering::Relaxed);
                shared.update_best_difficulty(difficulty);

                if difficulty >= job.share_difficulty {
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

            extranonce_counter = extranonce_counter.wrapping_add(worker_count as u64);
        }
    }
}

fn build_header(job: &JobTemplate, extranonce2: &str) -> Result<Vec<u8>, String> {
    let mut coinbase = decode_hex(&job.coinbase1)?;
    coinbase.extend(decode_hex(&job.extranonce1)?);
    coinbase.extend(decode_hex(extranonce2)?);
    coinbase.extend(decode_hex(&job.coinbase2)?);

    let mut merkle_root = double_sha256(&coinbase).to_vec();
    for branch in &job.merkle_branches {
        merkle_root.extend(decode_hex(branch)?);
        merkle_root = double_sha256(&merkle_root).to_vec();
    }

    let mut header = Vec::with_capacity(80);
    header.extend(reversed_hex(&job.version)?);
    header.extend(word_swapped_hex(&job.prev_hash)?);
    header.extend(merkle_root);
    header.extend(reversed_hex(&job.ntime)?);
    header.extend(reversed_hex(&job.nbits)?);
    header.extend([0_u8; 4]);

    if header.len() != 80 {
        return Err(format!(
            "pool produced an invalid {}-byte block header",
            header.len()
        ));
    }

    Ok(header)
}

fn decode_hex(value: &str) -> Result<Vec<u8>, String> {
    hex::decode(value).map_err(|error| format!("pool sent invalid hex: {error}"))
}

fn reversed_hex(value: &str) -> Result<Vec<u8>, String> {
    let mut bytes = decode_hex(value)?;
    bytes.reverse();
    Ok(bytes)
}

fn word_swapped_hex(value: &str) -> Result<Vec<u8>, String> {
    let mut bytes = decode_hex(value)?;

    if bytes.len() % 4 != 0 {
        return Err("pool sent a previous hash that is not word-aligned".into());
    }

    for word in bytes.chunks_exact_mut(4) {
        word.reverse();
    }

    Ok(bytes)
}

fn extranonce2_hex(counter: u64, size: usize) -> String {
    let mut bytes = vec![0_u8; size];
    let source = counter.to_be_bytes();
    let copied_bytes = size.min(source.len());
    bytes[size - copied_bytes..].copy_from_slice(&source[source.len() - copied_bytes..]);
    hex::encode(bytes)
}

fn double_sha256(value: &[u8]) -> [u8; 32] {
    let first_hash = Sha256::digest(value);
    Sha256::digest(first_hash).into()
}

fn difficulty_from_hash(hash: &[u8; 32]) -> f64 {
    let numeric_hash = hash
        .iter()
        .rev()
        .fold(0.0, |value, byte| value * 256.0 + f64::from(*byte));

    if numeric_hash == 0.0 {
        return DIFF_ONE_TARGET;
    }

    DIFF_ONE_TARGET / numeric_hash
}

fn write_message(stream: &mut TcpStream, message: &Value) -> Result<(), String> {
    let mut payload = serde_json::to_vec(message)
        .map_err(|error| format!("failed to encode Stratum JSON: {error}"))?;
    payload.push(b'\n');
    stream
        .write_all(&payload)
        .map_err(|error| format!("socket write failed: {error}"))
}

fn emit_stats(app: &AppHandle, shared: &SharedMiningState, hashrate: f64) {
    let _ = app.emit(STATS_EVENT, shared.snapshot(hashrate));
}

fn sleep_until_stopped(stop: &AtomicBool, duration: Duration) {
    let deadline = Instant::now() + duration;
    while !stop.load(Ordering::Acquire) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use std::io::{BufReader, Cursor, ErrorKind};

    use super::{
        difficulty_from_hash, extranonce2_hex, read_stratum_line, validate_mainnet_address,
        validate_share_difficulty, word_swapped_hex, MAX_PENDING_SUBMISSIONS,
        MAX_SHARE_SUBMISSIONS_PER_TICK, MAX_STRATUM_LINE_BYTES,
    };

    #[test]
    fn formats_extranonce2_to_pool_width() {
        assert_eq!(extranonce2_hex(1, 4), "00000001");
        assert_eq!(extranonce2_hex(0x1234, 2), "1234");
    }

    #[test]
    fn swaps_previous_hash_words_like_nerdminer() {
        assert_eq!(
            word_swapped_hex("11223344aabbccdd").unwrap(),
            vec![0x44, 0x33, 0x22, 0x11, 0xdd, 0xcc, 0xbb, 0xaa]
        );
    }

    #[test]
    fn zero_hash_has_maximum_reported_difficulty() {
        assert!(difficulty_from_hash(&[0; 32]).is_finite());
    }

    #[test]
    fn validates_mainnet_bitcoin_address_checksum_and_network() {
        assert!(validate_mainnet_address("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa").is_ok());
        assert!(validate_mainnet_address("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb").is_err());
        assert!(validate_mainnet_address("mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn").is_err());
    }

    #[test]
    fn rejects_pathological_share_difficulty() {
        assert!(validate_share_difficulty(0.0001).is_ok());
        assert!(validate_share_difficulty(0.0).is_err());
        assert!(validate_share_difficulty(f64::EPSILON).is_err());
        assert!(validate_share_difficulty(f64::INFINITY).is_err());
    }

    #[test]
    fn rejects_oversized_stratum_line_during_read() {
        let bytes = vec![b'a'; MAX_STRATUM_LINE_BYTES + 1];
        let mut reader = BufReader::new(Cursor::new(bytes));
        let error = read_stratum_line(&mut reader).unwrap_err();

        assert_eq!(error.kind(), ErrorKind::InvalidData);
    }

    #[test]
    fn caps_share_submission_budget() {
        assert_eq!(super::submission_budget(0), MAX_SHARE_SUBMISSIONS_PER_TICK);
        assert_eq!(super::submission_budget(MAX_PENDING_SUBMISSIONS - 1), 1);
        assert_eq!(super::submission_budget(MAX_PENDING_SUBMISSIONS), 0);
        assert_eq!(super::submission_budget(MAX_PENDING_SUBMISSIONS + 1), 0);
    }
}
