// Copyright (c) 2026 DYLO Gaming LLC. All rights reserved.
//! Self-update from GitHub Releases.
//!
//! Flow: query the latest release, compare its tag against our compiled
//! version, download the .exe asset, then hand off to a batch script that
//! waits for this process to exit, swaps the exe in place, and relaunches.

use anyhow::{anyhow, bail, Context, Result};

const REPO: &str = "dylogaming/Rotation-Lock";
const USER_AGENT: &str = concat!("rotation-lock/", env!("CARGO_PKG_VERSION"));

pub struct Update {
    pub version: String,
    download_url: String,
}

fn parse_ver(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.trim().trim_start_matches(['v', 'V']);
    let mut it = s.split('.').map(|p| {
        // Tolerate suffixes like "1.2.3-beta" on the last component.
        p.split(|c: char| !c.is_ascii_digit()).next().unwrap_or("").parse::<u64>()
    });
    Some((it.next()?.ok()?, it.next()?.ok()?, it.next().unwrap_or(Ok(0)).ok()?))
}

/// Returns Some(update) if the latest GitHub release is newer than this build.
pub fn check() -> Result<Option<Update>> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let resp: serde_json::Value = ureq::get(&url)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(15))
        .call()
        .context("querying GitHub releases")?
        .into_json()
        .context("parsing release JSON")?;

    let tag = resp["tag_name"].as_str().unwrap_or_default().to_string();
    let latest = parse_ver(&tag).ok_or_else(|| anyhow!("unparseable tag: {tag}"))?;
    let current = parse_ver(env!("CARGO_PKG_VERSION")).expect("valid crate version");
    if latest <= current {
        return Ok(None);
    }

    let assets = resp["assets"].as_array().cloned().unwrap_or_default();
    let asset = assets
        .iter()
        .find(|a| a["name"].as_str().is_some_and(|n| n.ends_with(".exe")))
        .ok_or_else(|| anyhow!("release {tag} has no .exe asset"))?;
    Ok(Some(Update {
        version: tag,
        download_url: asset["browser_download_url"]
            .as_str()
            .ok_or_else(|| anyhow!("asset missing download url"))?
            .to_string(),
    }))
}

/// Downloads the new exe and spawns the swap script. On success the caller
/// must exit the app promptly so the script can replace the binary.
pub fn download_and_stage(update: &Update, relaunch_tray: bool) -> Result<()> {
    let exe = std::env::current_exe().context("current exe path")?;
    let new_exe = exe.with_extension("exe.new");

    let resp = ureq::get(&update.download_url)
        .set("User-Agent", USER_AGENT)
        .timeout(std::time::Duration::from_secs(300))
        .call()
        .context("downloading update")?;
    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(&new_exe).context("creating staged exe")?;
    let written = std::io::copy(&mut reader, &mut file).context("writing staged exe")?;
    drop(file);
    if written < 1024 * 100 {
        let _ = std::fs::remove_file(&new_exe);
        bail!("downloaded file suspiciously small ({written} bytes)");
    }

    let script = exe.with_file_name("rotation-lock-update.cmd");
    let tray_arg = if relaunch_tray { " --tray" } else { "" };
    std::fs::write(
        &script,
        format!(
            "@echo off\r\n\
             :wait\r\n\
             timeout /t 1 /nobreak >nul\r\n\
             del \"{exe}\" 2>nul\r\n\
             if exist \"{exe}\" goto wait\r\n\
             move /y \"{new}\" \"{exe}\" >nul\r\n\
             start \"\" \"{exe}\"{tray_arg}\r\n\
             del \"%~f0\"\r\n",
            exe = exe.display(),
            new = new_exe.display(),
        ),
    )
    .context("writing update script")?;

    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("cmd")
        .args(["/c", &script.to_string_lossy()])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .context("spawning update script")?;
    Ok(())
}
