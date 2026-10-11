#![cfg_attr(windows, windows_subsystem = "windows")]
use std::{
    path::Path,
    process::{Command, Stdio},
};

fn main() -> std::io::Result<()> {
    // install-chrome.mjs records the actual Node and script paths on this PC.
    // Keep the native launcher relocatable without relying on Chrome's PATH.
    let config_path = std::env::current_exe()?.with_extension("json");
    let config: serde_json::Value = serde_json::from_slice(&std::fs::read(config_path)?)?;
    let node = config["node"].as_str().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Missing native host Node path",
        )
    })?;
    let script = config["script"].as_str().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Missing native host script path",
        )
    })?;
    let mut command = Command::new(Path::new(node));
    command
        .arg(script)
        .args(std::env::args_os().skip(1))
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let status = command.status()?;
    std::process::exit(status.code().unwrap_or(1));
}
