#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // GPU compatibility probe: run a tiny GPU batch in this process and exit.
    // Called by the main app as a child process to test if the GPU driver
    // will crash (segfault / STATUS_ACCESS_VIOLATION). If we exit with code 0,
    // the GPU is safe to use. Any crash kills only this child process.
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 2 && args[1] == "--gpu-probe" {
        let device_id = args.get(2).map(String::as_str);
        let intensity: u8 = args
            .get(3)
            .and_then(|s| s.parse().ok())
            .unwrap_or(25);

        match btc_lottery_pet_lib::gpu_probe(device_id, intensity) {
            Ok(name) => {
                eprintln!("[GPU Probe] OK: {name}");
                std::process::exit(0);
            }
            Err(e) => {
                eprintln!("[GPU Probe] FAIL: {e}");
                std::process::exit(1);
            }
        }
    }

    btc_lottery_pet_lib::run()
}
