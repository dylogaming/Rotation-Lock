// Copyright (c) 2026 DYLO Gaming LLC. All rights reserved.
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod elevation;
mod sensor;
mod state;
mod tasksched;
mod updater;

use state::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};

// Embed runtime icons at compile time.
const LOCK_GREEN_RGBA: &[u8] = include_bytes!("../icons/lock_green_64.rgba");
const LOCK_RED_RGBA:   &[u8] = include_bytes!("../icons/lock_red_64.rgba");

#[derive(Clone, serde::Serialize)]
struct StateUpdate {
    locked: bool,
    sensor_present: bool,
    message: Option<String>,
}

const RESUME_REAPPLY_AFTER: Duration = Duration::from_secs(20);
const RESUME_DEVICE_SETTLE: Duration = Duration::from_secs(5);

fn reapply_lock_if_configured(app: &AppHandle, state: &Arc<AppState>, reason: &str) {
    let Some(id) = state.config.lock().unwrap().selected_sensor.clone() else {
        return;
    };
    if !state.config.lock().unwrap().locked {
        return;
    }

    // Write the registry value FIRST so the taskbar layout reverts to laptop mode
    // immediately, independent of whether the device-removal step succeeds. Covers
    // the case where the sensor was already gone (lock fails entirely) and the
    // case where Windows re-enumerated the sensor on wake and it briefly reported
    // slate before we got here.
    let _ = sensor::force_laptop_chassis_state();

    match sensor::lock(&id) {
        Ok(msg) => {
            update_tray(app, true);
            let _ = app.emit("state-changed", StateUpdate {
                locked: true,
                sensor_present: sensor::is_present(&id),
                message: Some(format!("{reason}: {msg}")),
            });
        }
        Err(err) => {
            let _ = app.emit("state-changed", StateUpdate {
                locked: true,
                sensor_present: sensor::is_present(&id),
                message: Some(format!("{reason}: failed to reapply lock: {err}")),
            });
        }
    }
}

fn start_resume_monitor(app: AppHandle, state: Arc<AppState>) {
    std::thread::spawn(move || {
        let mut last_tick = SystemTime::now();
        loop {
            std::thread::sleep(Duration::from_secs(15));
            let now = SystemTime::now();
            let elapsed = now
                .duration_since(last_tick)
                .unwrap_or_else(|_| Duration::from_secs(0));
            last_tick = now;

            if elapsed >= RESUME_REAPPLY_AFTER {
                std::thread::sleep(RESUME_DEVICE_SETTLE);
                reapply_lock_if_configured(&app, &state, "resume");
            }
        }
    });
}

// Power-event hook: fires immediately on wake/resume, no polling.
// Stored statically so the C callback can reach back into Tauri state.
static RESUME_HOOK: OnceLock<(AppHandle, Arc<AppState>)> = OnceLock::new();

#[cfg(windows)]
unsafe extern "system" fn power_resume_callback(
    _ctx: *const std::ffi::c_void,
    event_type: u32,
    _setting: *const std::ffi::c_void,
) -> u32 {
    use windows::Win32::UI::WindowsAndMessaging::{PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND};
    if event_type == PBT_APMRESUMEAUTOMATIC || event_type == PBT_APMRESUMESUSPEND {
        if let Some((app, state)) = RESUME_HOOK.get() {
            let app = app.clone();
            let state = state.clone();
            std::thread::spawn(move || {
                std::thread::sleep(RESUME_DEVICE_SETTLE);
                reapply_lock_if_configured(&app, &state, "wake");
            });
        }
    }
    0
}

#[cfg(windows)]
fn install_resume_hook(app: AppHandle, state: Arc<AppState>) {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Power::{
        PowerRegisterSuspendResumeNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS,
    };
    use windows::Win32::UI::WindowsAndMessaging::DEVICE_NOTIFY_CALLBACK;

    if RESUME_HOOK.set((app, state)).is_err() {
        return;
    }

    // Leak the params struct: PowerRegisterSuspendResumeNotification holds the
    // pointer for the lifetime of the registration, which we keep for the
    // process lifetime.
    let params: &'static mut DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS =
        Box::leak(Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
            Callback: Some(power_resume_callback),
            Context: std::ptr::null_mut(),
        }));

    let mut handle: *mut std::ffi::c_void = std::ptr::null_mut();
    unsafe {
        let _ = PowerRegisterSuspendResumeNotification(
            DEVICE_NOTIFY_CALLBACK,
            HANDLE(params as *mut _ as *mut std::ffi::c_void),
            &mut handle,
        );
    }
    // handle is intentionally dropped — registration persists for process lifetime.
}

#[cfg(not(windows))]
fn install_resume_hook(_app: AppHandle, _state: Arc<AppState>) {}

#[tauri::command]
fn cmd_list_sensors() -> Result<Vec<sensor::SensorInfo>, String> {
    sensor::list_sensors().map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_get_config(state: tauri::State<Arc<AppState>>) -> state::Config {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
fn cmd_set_sensor(state: tauri::State<Arc<AppState>>, instance_id: String) -> Result<(), String> {
    state.config.lock().unwrap().selected_sensor = Some(instance_id);
    state.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_lock(app: AppHandle, state: tauri::State<Arc<AppState>>) -> Result<String, String> {
    let id = state.config.lock().unwrap().selected_sensor.clone()
        .ok_or("no sensor selected")?;
    let msg = sensor::lock(&id).map_err(|e| e.to_string())?;
    state.config.lock().unwrap().locked = true;
    state.save().map_err(|e| e.to_string())?;
    update_tray(&app, true);
    let _ = app.emit("state-changed", StateUpdate {
        locked: true, sensor_present: sensor::is_present(&id), message: Some(msg.clone()),
    });
    Ok(msg)
}

#[tauri::command]
fn cmd_unlock(app: AppHandle, state: tauri::State<Arc<AppState>>) -> Result<String, String> {
    let id = state.config.lock().unwrap().selected_sensor.clone()
        .ok_or("no sensor selected")?;
    let msg = sensor::unlock(&id).map_err(|e| e.to_string())?;
    state.config.lock().unwrap().locked = false;
    state.save().map_err(|e| e.to_string())?;
    update_tray(&app, false);
    let _ = app.emit("state-changed", StateUpdate {
        locked: false, sensor_present: sensor::is_present(&id), message: Some(msg.clone()),
    });
    Ok(msg)
}

#[tauri::command]
fn cmd_install_autostart() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_s = exe.to_string_lossy().into_owned();
    tasksched::install(&exe_s).map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_uninstall_autostart() -> Result<(), String> {
    tasksched::uninstall().map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_autostart_installed() -> bool { tasksched::is_installed() }

#[tauri::command]
fn cmd_set_start_locked(state: tauri::State<Arc<AppState>>, value: bool) -> Result<(), String> {
    state.config.lock().unwrap().start_locked = value;
    state.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_set_auto_update(state: tauri::State<Arc<AppState>>, value: bool) -> Result<(), String> {
    state.config.lock().unwrap().auto_update = value;
    state.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[derive(Clone, serde::Serialize)]
struct WhatsNew {
    version: String,
    notes: String,
}

/// Returns this build's release notes if the user hasn't seen them yet
/// (i.e. right after an update). Network call — invoked async from JS.
#[tauri::command]
fn cmd_whats_new(state: tauri::State<Arc<AppState>>) -> Option<WhatsNew> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    if state.config.lock().unwrap().last_seen_version.as_deref() == Some(current.as_str()) {
        return None;
    }
    match updater::notes_for_current() {
        Ok(Some(notes)) => Some(WhatsNew { version: current, notes }),
        _ => None,
    }
}

#[tauri::command]
fn cmd_ack_whats_new(state: tauri::State<Arc<AppState>>) -> Result<(), String> {
    state.config.lock().unwrap().last_seen_version = Some(env!("CARGO_PKG_VERSION").to_string());
    state.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_is_elevated() -> bool { elevation::is_elevated() }

// Authoritative visibility flag for the JS-side rAF/CSS gating. Tauri's
// is_visible() returns true on --tray launch even though the window is
// hidden, so we track this ourselves on every hide/show path.
static WINDOW_HIDDEN: AtomicBool = AtomicBool::new(false);

/// Persist window geometry, but only while the window is actually visible —
/// saving while hidden in the tray records garbage bounds (the old
/// window-state-plugin bug that made the app open tiny).
fn save_window_geometry(app: &AppHandle) {
    if WINDOW_HIDDEN.load(Ordering::Relaxed) {
        return;
    }
    let Some(win) = app.get_webview_window("main") else { return };
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.inner_size()) else { return };
    if size.width == 0 || size.height == 0 {
        return;
    }
    let state = app.state::<Arc<AppState>>();
    state.config.lock().unwrap().window = Some(state::WindowRect {
        x: pos.x,
        y: pos.y,
        w: size.width,
        h: size.height,
    });
    let _ = state.save();
}

fn restore_window_geometry(app: &AppHandle) {
    let state = app.state::<Arc<AppState>>();
    let Some(rect) = state.config.lock().unwrap().window else { return };
    let Some(win) = app.get_webview_window("main") else { return };
    // Clamp to the configured minimum (tauri.conf.json minWidth/minHeight)
    // so a corrupt save can't shrink the app.
    let sf = win.scale_factor().unwrap_or(1.0);
    let w = rect.w.max((340.0 * sf) as u32);
    let h = rect.h.max((390.0 * sf) as u32);
    let _ = win.set_size(tauri::PhysicalSize::new(w, h));
    let _ = win.set_position(tauri::PhysicalPosition::new(rect.x, rect.y));
}

#[tauri::command]
fn cmd_is_window_visible() -> bool {
    !WINDOW_HIDDEN.load(Ordering::Relaxed)
}

#[tauri::command]
fn cmd_hide_window(window: tauri::Window) -> Result<(), String> {
    save_window_geometry(window.app_handle());
    // Raw hide to mirror the raw no-activate show: tauri's hide() no-ops when
    // its internal visibility state is stale (we bypass show()).
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
            let _ = ShowWindow(windows::Win32::Foundation::HWND(hwnd.0 as _), SW_HIDE);
        }
    }
    let _ = window.hide();
    WINDOW_HIDDEN.store(true, Ordering::Relaxed);
    if let Some(wv) = window.app_handle().get_webview_window("main") {
        let _ = wv.eval("if(window.__rotationLockSetHidden) window.__rotationLockSetHidden(true);");
    }
    Ok(())
}

#[tauri::command]
fn cmd_quit_app(app: AppHandle) {
    quit_app(&app);
}

#[tauri::command]
fn cmd_open_url(url: String) -> Result<(), String> {
    // Allowlist: only http(s) URLs to avoid arbitrary command injection via shell.
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) URLs are allowed".into());
    }
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &url])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn build_tray_icon(locked: bool) -> Image<'static> {
    let rgba = if locked { LOCK_RED_RGBA } else { LOCK_GREEN_RGBA };
    // Verify shape: 64 * 64 * 4 = 16384 bytes
    debug_assert_eq!(rgba.len(), 64 * 64 * 4);
    Image::new_owned(rgba.to_vec(), 64, 64)
}

fn update_tray(app: &AppHandle, locked: bool) {
    let icon = build_tray_icon(locked);
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_icon(Some(icon.clone()));
        let tooltip = if locked { "Rotation Lock: LOCKED (laptop mode)" } else { "Rotation Lock: unlocked" };
        let _ = tray.set_tooltip(Some(tooltip));
    }
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_icon(icon);
    }
}

fn toggle_from_tray(app: &AppHandle) {
    let state = app.state::<Arc<AppState>>();
    let currently_locked = state.config.lock().unwrap().locked;
    if currently_locked {
        let _ = cmd_unlock(app.clone(), state);
    } else {
        let _ = cmd_lock(app.clone(), state);
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        // Show WITHOUT activating: tauri's show() maps to ShowWindow(SW_SHOW),
        // which steals keyboard focus. SW_SHOWNOACTIVATE does not.
        let shown_quietly = match win.hwnd() {
            Ok(hwnd) => unsafe {
                use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
                let _ = ShowWindow(windows::Win32::Foundation::HWND(hwnd.0 as _), SW_SHOWNOACTIVATE);
                true
            },
            Err(_) => false,
        };
        if !shown_quietly {
            let _ = win.show();
        }
        let _ = win.unminimize();
        WINDOW_HIDDEN.store(false, Ordering::Relaxed);
        let _ = win.eval("if(window.__rotationLockSetHidden) window.__rotationLockSetHidden(false);");
    }
}

fn quit_app(app: &AppHandle) {
    save_window_geometry(app);
    let state = app.state::<Arc<AppState>>();
    if state.config.lock().unwrap().locked {
        let _ = cmd_unlock(app.clone(), state);
    }
    app.exit(0);
}

fn main() {
    // Self-elevate if not admin. Keep the flow simple: if not elevated, launch elevated copy and exit.
    if !elevation::is_elevated() {
        let _ = elevation::relaunch_elevated();
        return;
    }

    let started_from_tray = std::env::args().any(|a| a == "--tray");

    let app_state = Arc::new(AppState::load().expect("load config"));

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Autostart re-triggers (unlock/resume) pass --tray; stay in the tray for those.
            if !args.iter().any(|a| a == "--tray") {
                show_main_window(app);
            }
        }))
        .manage(app_state.clone())
        .invoke_handler(tauri::generate_handler![
            cmd_list_sensors,
            cmd_get_config,
            cmd_set_sensor,
            cmd_lock,
            cmd_unlock,
            cmd_install_autostart,
            cmd_uninstall_autostart,
            cmd_autostart_installed,
            cmd_set_start_locked,
            cmd_set_auto_update,
            cmd_get_version,
            cmd_whats_new,
            cmd_ack_whats_new,
            cmd_is_elevated,
            cmd_open_url,
            cmd_hide_window,
            cmd_quit_app,
            cmd_is_window_visible,
        ])
        .on_window_event(|window, event| {
            // Persist geometry as the user moves/resizes (throttled) so the
            // last layout survives even a force-killed process.
            if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
                static LAST_SAVE: Mutex<Option<std::time::Instant>> = Mutex::new(None);
                let mut last = LAST_SAVE.lock().unwrap();
                let now = std::time::Instant::now();
                if last.map_or(true, |t| now.duration_since(t).as_millis() >= 500) {
                    *last = Some(now);
                    save_window_geometry(window.app_handle());
                }
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                // X = minimize to tray (standard tray-app behavior). Quit lives
                // in the gear menu and tray menu.
                api.prevent_close();
                save_window_geometry(window.app_handle());
                if let Ok(hwnd) = window.hwnd() {
                    unsafe {
                        use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
                        let _ = ShowWindow(windows::Win32::Foundation::HWND(hwnd.0 as _), SW_HIDE);
                    }
                }
                let _ = window.hide();
                WINDOW_HIDDEN.store(true, Ordering::Relaxed);
                if let Some(wv) = window.app_handle().get_webview_window("main") {
                    let _ = wv.eval("if(window.__rotationLockSetHidden) window.__rotationLockSetHidden(true);");
                }
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let locked = app_state.config.lock().unwrap().locked;
            let tray_menu = Menu::with_items(&handle, &[
                &MenuItem::with_id(&handle, "toggle", "Toggle lock", true, None::<&str>)?,
                &PredefinedMenuItem::separator(&handle)?,
                &MenuItem::with_id(&handle, "show", "Show window", true, None::<&str>)?,
                &MenuItem::with_id(&handle, "quit", "Quit", true, None::<&str>)?,
            ])?;
            TrayIconBuilder::with_id("main-tray")
                .icon(build_tray_icon(locked))
                .tooltip(if locked { "Rotation Lock: LOCKED" } else { "Rotation Lock: unlocked" })
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_from_tray(app),
                    "show" => show_main_window(app),
                    "quit" => quit_app(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        toggle_from_tray(tray.app_handle());
                    }
                })
                .build(app)?;

            // File/Help live in the in-app header (dist/index.html) — no native menu bar.

            // Initialize window icon to match current state
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_icon(build_tray_icon(locked));
            }

            if locked {
                reapply_lock_if_configured(&handle, &app_state, "startup");
            }

            restore_window_geometry(&handle);

            // Window is created hidden (visible: false). Only show it for a deliberate
            // launch; --tray (autostart/unlock re-trigger) stays in the tray.
            if started_from_tray {
                WINDOW_HIDDEN.store(true, Ordering::Relaxed);
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.eval("if(window.__rotationLockSetHidden) window.__rotationLockSetHidden(true);");
                }
                let cfg = app_state.config.lock().unwrap().clone();
                if cfg.start_locked {
                    if let Some(id) = cfg.selected_sensor.clone() {
                        let _ = sensor::lock(&id);
                        app_state.config.lock().unwrap().locked = true;
                        let _ = app_state.save();
                        update_tray(&handle, true);
                    }
                }
            } else {
                show_main_window(&handle);
            }

            start_resume_monitor(handle.clone(), app_state.clone());
            install_resume_hook(handle.clone(), app_state.clone());

            // Background auto-update: check GitHub shortly after launch; if a
            // newer release exists, stage it and restart to apply.
            {
                let handle = handle.clone();
                let app_state = app_state.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(8));
                    let update = match updater::check() {
                        Ok(Some(u)) => u,
                        Ok(None) => return,
                        Err(e) => {
                            eprintln!("update check failed: {e:#}");
                            return;
                        }
                    };
                    if !app_state.config.lock().unwrap().auto_update {
                        // Auto-update off: just light the bell with the notes.
                        let _ = handle.emit("update-available", WhatsNew {
                            version: update.version.clone(),
                            notes: update.notes.clone(),
                        });
                        return;
                    }
                    let _ = handle.emit("update-status", format!("Updating to {}…", update.version));
                    match updater::download_and_stage(&update, started_from_tray) {
                        Ok(()) => {
                            // Exit WITHOUT unlocking: the relaunched build reapplies
                            // the lock from config on startup.
                            handle.exit(0);
                        }
                        Err(e) => eprintln!("update failed: {e:#}"),
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
