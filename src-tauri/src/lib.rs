use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(serde::Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command]
fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|p| p.to_string())
}

#[tauri::command]
fn pick_file(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_file()
        .map(|p| p.to_string())
}

#[tauri::command]
fn pick_save_file(app: tauri::AppHandle, default_name: String) -> Option<String> {
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .blocking_save_file()
        .map(|p| p.to_string())
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let read = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut entries: Vec<DirEntry> = read
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }
            let is_dir = e.path().is_dir();
            let path = e.path().to_string_lossy().to_string();
            Some(DirEntry { name, path, is_dir })
        })
        .collect();

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_platform() -> &'static str {
    std::env::consts::OS
}

#[tauri::command]
fn get_cwd() -> String {
    std::env::current_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .to_string_lossy()
        .to_string()
}


struct PrefsLock(Mutex<()>);

fn prefs_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dir);
    dir.join("prefs.json")
}

#[tauri::command]
fn save_pref(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let state = app.state::<PrefsLock>();
    let _lock = state.0.lock().unwrap();
    let path = prefs_path(&app);
    let content = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
    let mut obj: serde_json::Value =
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}));
    obj[key] = serde_json::Value::String(value);
    std::fs::write(&path, obj.to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_pref(app: tauri::AppHandle, key: String) -> Option<String> {
    let path = prefs_path(&app);
    let content = std::fs::read_to_string(&path).ok()?;
    let obj: serde_json::Value = serde_json::from_str(&content).ok()?;
    obj[&key].as_str().map(|s| s.to_string())
}


#[tauri::command]
fn get_autosave_dir(app: tauri::AppHandle, custom_path: String) -> Result<String, String> {
    let dir = if custom_path.trim().is_empty() {
        app.path().app_config_dir().map_err(|e| e.to_string())?.join("autosave")
    } else {
        std::path::PathBuf::from(custom_path.trim())
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}


#[tauri::command]
fn create_file_cmd(path: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, "").map_err(|e| e.to_string())
}

#[tauri::command]
fn create_dir_cmd(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_path(old_path: String, new_path: String) -> Result<(), String> {
    std::fs::rename(&old_path, &new_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(p).map_err(|e| e.to_string())
    }
}


#[derive(serde::Serialize)]
struct SearchResult {
    file:        String,
    line:        u32,
    text:        String,
    match_start: u32,
    match_end:   u32,
}

#[tauri::command]
fn search_in_files(root: String, query: String, max_results: u32) -> Vec<SearchResult> {
    let mut results = Vec::new();
    if query.is_empty() { return results; }
    search_dir(std::path::Path::new(&root), &query.to_lowercase(), &mut results, max_results);
    results
}

fn search_dir(
    dir: &std::path::Path,
    query: &str,
    out: &mut Vec<SearchResult>,
    max: u32,
) {
    if out.len() >= max as usize { return; }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if out.len() >= max as usize { return; }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') { continue; }
        let path = entry.path();
        if path.is_dir() {
            if matches!(name.as_str(), "node_modules"|"target"|"dist"|"build"|".cache"|"__pycache__") {
                continue;
            }
            search_dir(&path, query, out, max);
        } else {
            let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
            if matches!(ext.as_str(), "png"|"jpg"|"jpeg"|"gif"|"ico"|"woff"|"woff2"|"ttf"|"eot"|"pdf"|"zip"|"gz"|"tar"|"exe"|"dll"|"so"|"dylib"|"bin"|"dat") {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&path) else { continue };
            let lower = content.to_lowercase();
            let mut pos = 0;
            while pos < lower.len() {
                let Some(idx) = lower[pos..].find(query) else { break };
                let abs = pos + idx;
                let line_num = content[..abs].chars().filter(|&c| c == '\n').count() as u32 + 1;
                let ls = content[..abs].rfind('\n').map(|p| p + 1).unwrap_or(0);
                let le = content[abs..].find('\n').map(|p| abs + p).unwrap_or(content.len());
                out.push(SearchResult {
                    file:        path.to_string_lossy().to_string(),
                    line:        line_num,
                    text:        content[ls..le].trim().to_string(),
                    match_start: (abs - ls) as u32,
                    match_end:   (abs - ls + query.len()) as u32,
                });
                if out.len() >= max as usize { break; }
                pos = abs + query.len().max(1);
            }
        }
    }
}


#[tauri::command]
fn git_status(path: String) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();

    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("git");
    cmd.args(["status", "--porcelain=v1", "-uall"])
        .current_dir(&path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    let Ok(out) = cmd.output() else { return map };

    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        if line.len() < 4 { continue; }
        let mut chars = line[..2].chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');
        let file_part = line[3..].trim_matches('"');

        // Renames: "R old -> new"
        let file = if (x == 'R' || x == 'C') && file_part.contains(" -> ") {
            file_part.split(" -> ").last().unwrap_or(file_part)
        } else {
            file_part
        };

        let status = if x == '?' && y == '?' {
            "U"
        } else {
            let ch = if x != ' ' && x != '?' { x } else { y };
            match ch {
                'M' => "M",
                'D' => "D",
                'A' => "A",
                'R' | 'C' => "M",
                _ => continue,
            }
        };

        // Git always uses forward slashes; store as-is
        map.insert(file.to_string(), status.to_string());
    }

    map
}


#[tauri::command]
fn git_branch(path: String) -> Option<String> {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("git");
    cmd.args(["branch", "--show-current"])
        .current_dir(&path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    let out = cmd.output().ok()?;
    let branch = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if branch.is_empty() { None } else { Some(branch) }
}


#[tauri::command]
fn set_title(app: tauri::AppHandle, title: String) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or_else(|| "window not found".to_string())?
        .set_title(&title)
        .map_err(|e| e.to_string())
}


#[tauri::command]
fn list_all_files(path: String, max_depth: u32) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    collect_files(std::path::Path::new(&path), 0, max_depth, &mut files);
    Ok(files)
}

fn collect_files(dir: &std::path::Path, depth: u32, max_depth: u32, out: &mut Vec<String>) {
    if depth > max_depth || out.len() >= 5000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let p = entry.path();
        if p.is_dir() {
            if matches!(
                name.as_str(),
                "node_modules" | "target" | "dist" | "build" | ".cache" | "__pycache__"
            ) {
                continue;
            }
            collect_files(&p, depth + 1, max_depth, out);
        } else {
            out.push(p.to_string_lossy().to_string());
        }
    }
}


#[cfg(target_os = "windows")]
fn get_cpu_name() -> String {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("reg")
        .args(["query", r"HKLM\HARDWARE\DESCRIPTION\System\CentralProcessor\0", "/v", "ProcessorNameString"])
        .creation_flags(0x0800_0000)
        .output()
        .ok();
    if let Some(o) = out {
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            if line.contains("ProcessorNameString") {
                if let Some(val) = line.split("REG_SZ").nth(1) {
                    let v = val.trim().to_string();
                    if !v.is_empty() { return v; }
                }
            }
        }
    }
    "Unknown".to_string()
}

#[cfg(target_os = "macos")]
fn get_cpu_name() -> String {
    std::process::Command::new("sysctl")
        .args(["-n", "machdep.cpu.brand_string"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "Unknown".to_string())
}

#[cfg(target_os = "linux")]
fn get_cpu_name() -> String {
    std::fs::read_to_string("/proc/cpuinfo")
        .unwrap_or_default()
        .lines()
        .find(|l| l.starts_with("model name"))
        .and_then(|l| l.split(':').nth(1))
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "Unknown".to_string())
}

#[tauri::command]
fn get_app_info() -> serde_json::Value {
    serde_json::json!({
        "version":  env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "cpu":      get_cpu_name(),
    })
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&url).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(&url).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}


#[derive(serde::Serialize, Clone)]
struct PtyData {
    id: u32,
    text: String,
}

struct PtySession {
    writer: Box<dyn std::io::Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

struct PtySessions(Mutex<HashMap<u32, PtySession>>);

#[cfg(target_os = "windows")]
fn build_pty_cmd(_shell: &str, cmd: &str) -> portable_pty::CommandBuilder {
    // Always spawn interactive programs directly — never via cmd /C wrapper.
    // cmd /C creates an intermediate pipe between the program and ConPTY,
    // which can swallow output before it reaches the reader.
    let mut parts = cmd.split_whitespace();
    let exe  = parts.next().unwrap_or("python");
    let args: Vec<&str> = parts.collect();
    let mut c = portable_pty::CommandBuilder::new(exe);
    if !args.is_empty() { c.args(args); }
    c
}

#[cfg(not(target_os = "windows"))]
fn build_pty_cmd(shell: &str, cmd: &str) -> portable_pty::CommandBuilder {
    let exe = match shell { "bash" => "bash", "zsh" => "zsh", _ => "sh" };
    let mut c = portable_pty::CommandBuilder::new(exe);
    c.args(["-c", cmd]);
    c
}

#[tauri::command]
fn start_pty(
    app: tauri::AppHandle,
    pty_state: tauri::State<'_, PtySessions>,
    id: u32,
    cmd: String,
    cwd: String,
    shell: String,
) -> Result<(), String> {
    use portable_pty::{native_pty_system, PtySize};
    use std::io::Read;
    use std::thread;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 220, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd_builder = build_pty_cmd(&shell, &cmd);
    if !cwd.is_empty() {
        cmd_builder.cwd(&cwd);
    }
    cmd_builder.env("PYTHONUNBUFFERED", "1");
    cmd_builder.env("TERM", "xterm-256color");
    cmd_builder.env("COLORTERM", "truecolor");

    let mut child = pair.slave.spawn_command(cmd_builder).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    {
        let mut sessions = pty_state.0.lock().unwrap();
        sessions.insert(id, PtySession { writer, master: pair.master });
    }

    let (tx, rx) = std::sync::mpsc::channel::<i32>();
    let a1 = app.clone();
    let a2 = app.clone();

    // Waiter: reap child, wait for output to drain, then drop master to unblock reader
    thread::spawn(move || {
        let code = child.wait()
            .map(|s| if s.success() { 0i32 } else { 1i32 })
            .unwrap_or(-1);
        // Give the reader ~300ms to drain remaining output before closing ConPTY
        std::thread::sleep(std::time::Duration::from_millis(300));
        a2.state::<PtySessions>().0.lock().unwrap().remove(&id);
        let _ = tx.send(code);
    });

    // Reader: stream output; exits when ConPTY closes (waiter drops master)
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = a1.emit("pty-data", PtyData { id, text });
                }
            }
        }
        let code = rx.recv().unwrap_or(-1);
        let _ = a1.emit("term-exit", TermExit { id, code });
    });

    Ok(())
}

#[tauri::command]
fn write_pty(pty_state: tauri::State<'_, PtySessions>, id: u32, data: String) -> Result<(), String> {
    use std::io::Write;
    let mut sessions = pty_state.0.lock().unwrap();
    if let Some(sess) = sessions.get_mut(&id) {
        sess.writer.write_all(data.as_bytes()).map_err(|e: std::io::Error| e.to_string())?;
        sess.writer.flush().map_err(|e: std::io::Error| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn resize_pty(pty_state: tauri::State<'_, PtySessions>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    use portable_pty::PtySize;
    let sessions = pty_state.0.lock().unwrap();
    if let Some(sess) = sessions.get(&id) {
        sess.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn kill_pty(pty_state: tauri::State<'_, PtySessions>, id: u32) {
    pty_state.0.lock().unwrap().remove(&id);
}


#[cfg(target_os = "windows")]
fn find_git_bash() -> Option<String> {
    let candidates = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
    ];
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return Some(c.to_string());
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn build_shell_command(shell: &str, cmd: &str) -> std::process::Command {
    match shell {
        "powershell" => {
            let mut c = std::process::Command::new("powershell");
            c.args(["-NoProfile", "-Command", cmd]);
            c
        }
        "gitbash" => {
            let bash = find_git_bash().unwrap_or_else(|| "bash".to_string());
            let mut c = std::process::Command::new(bash);
            c.args(["-c", cmd]);
            c
        }
        _ => {
            let mut c = std::process::Command::new("cmd");
            c.args(["/C", cmd]);
            c
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn build_shell_command(shell: &str, cmd: &str) -> std::process::Command {
    let exe = match shell { "bash" => "bash", "zsh" => "zsh", _ => "sh" };
    let mut c = std::process::Command::new(exe);
    c.args(["-c", cmd]);
    c
}

#[cfg(target_os = "windows")]
fn available_shells_list() -> Vec<String> {
    let mut shells = vec!["cmd".to_string(), "powershell".to_string()];
    if find_git_bash().is_some() { shells.push("gitbash".to_string()); }
    shells
}

#[cfg(not(target_os = "windows"))]
fn available_shells_list() -> Vec<String> {
    let mut shells = vec!["sh".to_string()];
    if std::path::Path::new("/bin/bash").exists() || std::path::Path::new("/usr/bin/bash").exists() {
        shells.push("bash".to_string());
    }
    if std::path::Path::new("/bin/zsh").exists() || std::path::Path::new("/usr/bin/zsh").exists() {
        shells.push("zsh".to_string());
    }
    shells
}

#[tauri::command]
fn available_shells() -> Vec<String> { available_shells_list() }

#[derive(serde::Serialize, Clone)]
struct TermData {
    id: u32,
    text: String,
    is_err: bool,
}

#[derive(serde::Serialize, Clone)]
struct TermExit {
    id: u32,
    code: i32,
}

struct CmdEntry {
    stdin: Option<std::process::ChildStdin>,
    pid:   u32,
}
struct CmdState(Mutex<HashMap<u32, CmdEntry>>);

#[tauri::command]
fn start_command(
    app:       tauri::AppHandle,
    cmd_state: tauri::State<'_, CmdState>,
    id:        u32,
    cmd:       String,
    cwd:       String,
    shell:     String,
) -> Result<(), String> {
    use std::io::BufRead;
    use std::thread;

    if cmd.len() > MAX_CMD_LEN {
        return Err(format!("command too long (max {MAX_CMD_LEN} bytes)"));
    }

    let run_dir = if cwd.is_empty() {
        std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
    } else {
        std::path::PathBuf::from(&cwd)
    };

    let mut builder = build_shell_command(&shell, &cmd);
    builder
        .current_dir(&run_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::piped())
        // Force colour output for common tools
        .env("FORCE_COLOR",         "1")
        .env("CARGO_TERM_COLOR",    "always")
        .env("COLORTERM",           "truecolor")
        .env("PYTHONUNBUFFERED",    "1")
        .env("TERM",                "xterm-256color");

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        builder.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = builder.spawn().map_err(|e| e.to_string())?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let stdin  = child.stdin.take();
    let pid = child.id();

    cmd_state.0.lock().unwrap().insert(id, CmdEntry { stdin, pid });

    let a1 = app.clone();
    let a2 = app.clone();

    thread::spawn(move || {
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines().flatten() {
            let _ = a1.emit("term-data", TermData { id, text: line, is_err: false });
        }
    });

    thread::spawn(move || {
        let reader = std::io::BufReader::new(stderr);
        for line in reader.lines().flatten() {
            let _ = a2.emit("term-data", TermData { id, text: line, is_err: true });
        }
    });

    thread::spawn(move || {
        let code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
        app.state::<CmdState>().0.lock().unwrap().remove(&id);
        let _ = app.emit("term-exit", TermExit { id, code });
    });

    Ok(())
}

#[tauri::command]
fn write_cmd_stdin(cmd_state: tauri::State<'_, CmdState>, id: u32, data: String) -> Result<(), String> {
    use std::io::Write;
    let mut map = cmd_state.0.lock().unwrap();
    if let Some(entry) = map.get_mut(&id) {
        if let Some(stdin) = &mut entry.stdin {
            stdin.write_all(data.as_bytes()).map_err(|e: std::io::Error| e.to_string())?;
            stdin.flush().map_err(|e: std::io::Error| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn kill_cmd(cmd_state: tauri::State<'_, CmdState>, id: u32) {
    let pid = cmd_state.0.lock().unwrap().get(&id).map(|e| e.pid);
    if let Some(pid) = pid {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .creation_flags(0x0800_0000)
                .output();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = std::process::Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .output();
        }
    }
}

#[tauri::command]
#[allow(dead_code)]
fn get_file_mtime(path: String) -> Option<u64> {
    std::fs::metadata(&path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
}

const MAX_CMD_LEN: usize = 8_192;

// Strips credential/secret env vars before passing env to language servers.
#[allow(dead_code)]
const SCRUB_PATTERNS: &[&str] = &[
    "TOKEN", "SECRET", "PASSWORD", "PASSWD", "PRIVATE_KEY", "API_KEY", "API_SECRET",
    "AWS_ACCESS", "AWS_SECRET", "AWS_SESSION",
    "AZURE_CLIENT", "GOOGLE_APPLICATION",
    "DATABASE_URL", "MONGO_URI", "REDIS_URL",
    "NPM_TOKEN", "CARGO_REGISTRY",
    "SSH_AUTH_SOCK", "SSH_AGENT_PID",
];

#[allow(dead_code)]
fn scrub_env() -> Vec<(String, String)> {
    std::env::vars()
        .filter(|(k, _)| {
            let ku = k.to_uppercase();
            !SCRUB_PATTERNS.iter().any(|p| ku.contains(p))
        })
        .collect()
}

// Verifies a path is inside the open workspace root (canonicalized).
fn within_workspace(path: &str, workspace_root: &str) -> bool {
    if workspace_root.is_empty() || path.is_empty() { return false; }
    let Ok(p) = std::fs::canonicalize(path)           else { return false; };
    let Ok(w) = std::fs::canonicalize(workspace_root) else { return false; };
    p.starts_with(&w)
}

// Resolves a bare binary name (no slashes, no dots) by searching PATH.
fn find_binary(name: &str) -> Option<String> {
    let path_var = std::env::var("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path_var) {
        #[cfg(target_os = "windows")]
        {
            // On Windows check extensions first — the plain name may be a Unix sh script
            for ext in &["exe", "cmd", "bat"] {
                let pe = dir.join(format!("{name}.{ext}"));
                if pe.is_file() { return Some(pe.to_string_lossy().to_string()); }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let p = dir.join(name);
            if p.is_file() { return Some(p.to_string_lossy().to_string()); }
        }
    }
    None
}

/// On Windows, npm-installed binaries are .cmd wrappers around node.exe.
/// Spawning them via cmd.exe /C doesn't reliably pipe stdin/stdout for LSP.
/// Instead, read the .cmd to find the node_modules script and invoke node directly.
#[cfg(target_os = "windows")]
fn resolve_node_cmd(cmd_path: &str) -> Option<(String, String)> {
    let dir = std::path::Path::new(cmd_path).parent()?;
    let content = std::fs::read_to_string(cmd_path).ok()?;
    // Find "node_modules\..." pattern in the .cmd content
    let nm_idx = content.find("node_modules")?;
    let after = &content[nm_idx..];
    let end = after.find(|c: char| c == '"' || c == '\'' || c == '\r' || c == '\n' || c == ' ')
        .unwrap_or(after.len());
    let relative = after[..end].replace('/', "\\");
    let script = dir.join(&relative);
    if !script.exists() { return None; }
    // Find node.exe: check npm dir first, then PATH
    let node = {
        let local = dir.join("node.exe");
        if local.exists() { local.to_string_lossy().to_string() }
        else { find_binary("node")? }
    };
    Some((node, script.to_string_lossy().to_string()))
}

/// Returns (executable, prepended_args) for spawning a binary.
/// On Windows, resolves npm .cmd wrappers to direct node.exe invocations.
#[cfg(target_os = "windows")]
fn cmd_wrap(binary: &str) -> (String, Vec<String>) {
    if binary.ends_with(".cmd") || binary.ends_with(".bat") {
        if let Some((node, script)) = resolve_node_cmd(binary) {
            return (node, vec![script]);
        }
        // Fallback: cmd.exe /C (less reliable for piped I/O but better than nothing)
        ("cmd.exe".to_string(), vec!["/C".to_string(), binary.to_string()])
    } else {
        (binary.to_string(), vec![])
    }
}
#[cfg(not(target_os = "windows"))]
fn cmd_wrap(binary: &str) -> (String, Vec<String>) {
    (binary.to_string(), vec![])
}

#[tauri::command]
fn lsp_find_binary(name: String) -> Option<String> {
    if name.len() > 64 || name.contains(['/', '\\', '.']) { return None; }
    find_binary(&name)
}

#[derive(serde::Serialize)]
struct LspProbe { installed: bool, version: String, path: String }

#[tauri::command]
fn lsp_probe(name: String) -> LspProbe {
    let empty = LspProbe { installed: false, version: String::new(), path: String::new() };
    if name.len() > 64 || name.contains(['/', '\\', '.']) { return empty; }
    let Some(path) = find_binary(&name) else { return empty; };

    let (exe, pre) = cmd_wrap(&path);
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(&exe);
    cmd.args(&pre).arg("--version")
       .stdout(std::process::Stdio::piped())
       .stderr(std::process::Stdio::piped()); // some tools print version to stderr
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    match cmd.output() {
        Ok(out) if out.status.success() => {
            let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let v = if v.is_empty() { String::from_utf8_lossy(&out.stderr).trim().to_string() } else { v };
            LspProbe { installed: true, version: v, path }
        }
        _ => empty,
    }
}

#[tauri::command]
fn lsp_check_workspace(path: String, workspace: String) -> bool {
    within_workspace(&path, &workspace)
}


#[derive(serde::Serialize, Clone)]
struct LspMessage { language: String, data: String }

struct LspProc {
    stdin:       std::io::BufWriter<std::process::ChildStdin>,
    pid:         u32,
    initialized: bool,
}

struct LspState(std::sync::Arc<Mutex<HashMap<String, LspProc>>>);

fn read_lsp_body(reader: &mut impl std::io::BufRead) -> Option<String> {
    let mut content_len = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 { return None; }
        let trimmed = line.trim_end_matches(|c: char| c == '\r' || c == '\n');
        if trimmed.is_empty() { break; }
        if let Some(rest) = trimmed.strip_prefix("Content-Length: ") {
            content_len = rest.trim().parse().unwrap_or(0);
        }
    }
    if content_len == 0 { return None; }
    let mut body = vec![0u8; content_len];
    use std::io::Read;
    reader.read_exact(&mut body).ok()?;
    String::from_utf8(body).ok()
}

fn kill_pid(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(0x0800_0000)
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output();
    }
}

#[tauri::command]
fn lsp_start(
    app:       tauri::AppHandle,
    lsp_state: tauri::State<'_, LspState>,
    language:  String,
    binary:    String,
    args:      Vec<String>,
    workspace: String,
) -> Result<(), String> {
    // Stop existing server for this language
    let old_pid = lsp_state.0.lock().unwrap().remove(&language).map(|p| p.pid);
    if let Some(pid) = old_pid { kill_pid(pid); }

    let (exe, pre) = cmd_wrap(&binary);
    let mut cmd = std::process::Command::new(&exe);
    cmd.args(&pre).args(&args)
       .stdin(std::process::Stdio::piped())
       .stdout(std::process::Stdio::piped())
       .stderr(std::process::Stdio::piped());

    cmd.env_clear();
    for (k, v) in scrub_env() { cmd.env(k, v); }
    if !workspace.is_empty() { cmd.current_dir(&workspace); }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdin  = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let pid    = child.id();

    lsp_state.0.lock().unwrap().insert(language.clone(), LspProc {
        stdin: std::io::BufWriter::new(stdin),
        pid,
        initialized: false,
    });

    // Watchdog: kill the process if JS never confirms initialization within 30 s
    {
        let state_arc = std::sync::Arc::clone(&lsp_state.0);
        let lang_w    = language.clone();
        let pid_w     = pid;
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(30));
            let mut map = state_arc.lock().unwrap();
            if let Some(proc) = map.get(&lang_w) {
                if proc.pid == pid_w && !proc.initialized {
                    map.remove(&lang_w);
                    drop(map);
                    kill_pid(pid_w);
                }
            }
        });
    }

    let lang = language.clone();
    let a1   = app.clone();

    // Reader: parse Content-Length framed JSON-RPC and emit events
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stdout);
        while let Some(body) = read_lsp_body(&mut reader) {
            let _ = a1.emit("lsp-message", LspMessage { language: lang.clone(), data: body });
        }
        let _ = a1.emit("lsp-exit", LspMessage { language: lang, data: String::new() });
    });

    // Stderr: write to log file in app config dir
    let log_path = app.path().app_config_dir().ok()
        .map(|d| d.join(format!("lsp_{language}.log")));

    std::thread::spawn(move || {
        use std::io::BufRead;
        let mut log = log_path.and_then(|p| std::fs::File::create(p).ok());
        for line in std::io::BufReader::new(stderr).lines().flatten() {
            if let Some(f) = &mut log {
                use std::io::Write;
                let _ = writeln!(f, "{line}");
                let _ = f.flush();
            }
        }
        let _ = child.wait();
    });

    Ok(())
}

#[tauri::command]
fn lsp_send(
    lsp_state: tauri::State<'_, LspState>,
    language:  String,
    message:   String,
) -> Result<(), String> {
    use std::io::Write;
    if message.len() > 1_048_576 { return Err("LSP message too large".into()); }
    let mut state = lsp_state.0.lock().unwrap();
    let proc = state.get_mut(&language)
        .ok_or_else(|| format!("no LSP server running for {language}"))?;
    let header = format!("Content-Length: {}\r\n\r\n", message.len());
    proc.stdin.write_all(header.as_bytes()).map_err(|e| e.to_string())?;
    proc.stdin.write_all(message.as_bytes()).map_err(|e| e.to_string())?;
    proc.stdin.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn lsp_stop(lsp_state: tauri::State<'_, LspState>, language: String) {
    if let Some(proc) = lsp_state.0.lock().unwrap().remove(&language) {
        kill_pid(proc.pid);
    }
}

#[tauri::command]
fn lsp_confirm_initialized(lsp_state: tauri::State<'_, LspState>, language: String) {
    if let Some(proc) = lsp_state.0.lock().unwrap().get_mut(&language) {
        proc.initialized = true;
    }
}

static PENDING_MANIFEST_URL: std::sync::OnceLock<std::sync::Mutex<Option<String>>> =
    std::sync::OnceLock::new();

fn pending_manifest() -> &'static std::sync::Mutex<Option<String>> {
    PENDING_MANIFEST_URL.get_or_init(|| std::sync::Mutex::new(None))
}

fn read_update_channel(app: &tauri::AppHandle) -> String {
    let path = prefs_path(app);
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    let prefs: serde_json::Value = serde_json::from_str(&content).unwrap_or(serde_json::json!({}));
    let settings_str = prefs["settings"].as_str().unwrap_or("{}");
    let settings: serde_json::Value = serde_json::from_str(settings_str).unwrap_or(serde_json::json!({}));
    settings["updateChannel"].as_str().unwrap_or("stable").to_string()
}

async fn fetch_manifest_url(beta: bool) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("LittleNotepad-Updater/1.0")
        .build().map_err(|e| e.to_string())?;

    let releases: Vec<serde_json::Value> = client
        .get("https://api.github.com/repos/openidle-dev/littlenotepad/releases")
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;

    for release in &releases {
        let is_pre = release["prerelease"].as_bool().unwrap_or(false);
        if !beta && is_pre { continue; }
        if let Some(assets) = release["assets"].as_array() {
            for asset in assets {
                if asset["name"].as_str() == Some("latest.json") {
                    if let Some(url) = asset["browser_download_url"].as_str() {
                        return Ok(url.to_string());
                    }
                }
            }
        }
    }
    Err("No update manifest found in releases".to_string())
}

#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let beta = read_update_channel(&app) == "beta";
    let manifest_url = fetch_manifest_url(beta).await?;
    *pending_manifest().lock().unwrap() = Some(manifest_url.clone());
    let url = url::Url::parse(&manifest_url).map_err(|e| e.to_string())?;
    let update = app.updater_builder()
        .endpoints(vec![url]).map_err(|e| e.to_string())?
        .build().map_err(|e| e.to_string())?
        .check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| serde_json::json!({
        "version": u.version,
        "body": u.body,
    })))
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let manifest_url = pending_manifest().lock().unwrap().clone()
        .ok_or_else(|| "No pending update — run check_update first".to_string())?;
    let url = url::Url::parse(&manifest_url).map_err(|e| e.to_string())?;
    let update = app.updater_builder()
        .endpoints(vec![url]).map_err(|e| e.to_string())?
        .build().map_err(|e| e.to_string())?
        .check().await.map_err(|e| e.to_string())?;
    if let Some(update) = update {
        update.download_and_install(|_, _| {}, || {})
            .await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(PrefsLock(Mutex::new(())))
        .manage(PtySessions(Mutex::new(HashMap::new())))
        .manage(CmdState(Mutex::new(HashMap::new())))
        .manage(LspState(std::sync::Arc::new(Mutex::new(HashMap::new()))));

    #[cfg(target_os = "windows")]
    let builder = builder.plugin(
        tauri_plugin_prevent_default::Builder::new()
            .platform(tauri_plugin_prevent_default::PlatformOptions::new()
                .browser_accelerator_keys(false))
            .build()
    );

    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.eval("window.__openCommandPalette?.()");
                        }
                    }
                })
                .build()
        )
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Enter { .. }) => {
                    for wv in window.webviews() {
                        let _ = wv.eval(
                            "document.getElementById('editor-panel')\
                             ?.classList.add('drop-active')"
                        );
                    }
                }
                tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                    let json = serde_json::to_string(
                        &paths.iter()
                            .map(|p| p.to_string_lossy().replace('\\', "/"))
                            .collect::<Vec<_>>()
                    ).unwrap_or_default();
                    for wv in window.webviews() {
                        let _ = wv.eval(&format!(
                            "window.__onFileDrop?.({json}); \
                             document.getElementById('editor-panel')\
                             ?.classList.remove('drop-active')"
                        ));
                    }
                }
                tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Leave) => {
                    for wv in window.webviews() {
                        let _ = wv.eval(
                            "document.getElementById('editor-panel')\
                             ?.classList.remove('drop-active')"
                        );
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyP);
            let _ = app.global_shortcut().register(shortcut);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            pick_file,
            pick_save_file,
            list_dir,
            read_file,
            write_file,
            get_platform,
            get_cwd,
            list_all_files,
            start_command,
            available_shells,
            get_app_info,
            open_url,
            save_pref,
            load_pref,
            create_file_cmd,
            create_dir_cmd,
            rename_path,
            delete_path,
            search_in_files,
            set_title,
            git_status,
            git_branch,
            get_file_mtime,
            get_autosave_dir,
            write_cmd_stdin,
            kill_cmd,
            start_pty,
            write_pty,
            resize_pty,
            kill_pty,
            lsp_find_binary,
            lsp_probe,
            lsp_check_workspace,
            lsp_start,
            lsp_send,
            lsp_stop,
            lsp_confirm_initialized,
            check_update,
            install_update,
            restart_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LittleNotepad");
}
