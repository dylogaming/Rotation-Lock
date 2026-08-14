// Copyright (c) 2026 DYLO Gaming LLC. All rights reserved.
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Config {
    pub selected_sensor: Option<String>,
    pub locked: bool,
    pub autostart: bool,
    pub start_locked: bool,
    #[serde(default = "default_true")]
    pub auto_update: bool,
    /// Last version whose release notes the user has seen (bell cleared).
    #[serde(default)]
    pub last_seen_version: Option<String>,
    /// Saved window geometry (physical px), captured only while visible.
    #[serde(default)]
    pub window: Option<WindowRect>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
pub struct WindowRect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

fn default_true() -> bool {
    true
}

impl Default for Config {
    fn default() -> Self {
        Self {
            selected_sensor: None,
            locked: false,
            autostart: false,
            start_locked: false,
            auto_update: true,
            last_seen_version: None,
            window: None,
        }
    }
}

pub struct AppState {
    pub config: Mutex<Config>,
    pub config_path: PathBuf,
}

impl AppState {
    pub fn load() -> Result<Self> {
        let path = config_path()?;
        let config = if path.exists() {
            serde_json::from_str::<Config>(&std::fs::read_to_string(&path)?).unwrap_or_default()
        } else {
            Config::default()
        };
        Ok(Self {
            config: Mutex::new(config),
            config_path: path,
        })
    }

    pub fn save(&self) -> Result<()> {
        let cfg = self.config.lock().unwrap().clone();
        if let Some(parent) = self.config_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&self.config_path, serde_json::to_string_pretty(&cfg)?)?;
        Ok(())
    }
}

/// Config file lives next to the exe for portability.
fn config_path() -> Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let dir = exe.parent().unwrap_or(std::path::Path::new("."));
    Ok(dir.join("rotation-lock.config.json"))
}
