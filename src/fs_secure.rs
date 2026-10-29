//! Security-hardened filesystem primitives: bounded reads, private dirs,
//! atomic settings writes. Mirrors the Node bridge's semantics exactly.

use crate::config::get_settings_path;
use crate::util::*;
use serde_json::Value;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

/// JS readBoundedFile: O_NOFOLLOW|O_NONBLOCK open, regular-file + size +
/// owner checks, chmod 0600 when group/other bits are set. ENOENT (absent),
/// ELOOP (symlink), ENXIO (FIFO w/ O_NONBLOCK) all return None.
pub fn read_bounded_file(path: &Path, max_bytes: usize) -> Option<String> {
    let open = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path);
    let fd = match open {
        Ok(f) => f,
        Err(e) => {
            let _ = e;
            return None;
        }
    };
    read_bounded_fd(fd, max_bytes)
}

fn read_bounded_fd(fd: File, max_bytes: usize) -> Option<String> {
    let st = fd.metadata().ok()?;
    if !st.is_file() || st.size() as usize > max_bytes {
        return None;
    }
    let uid = unsafe { libc::getuid() };
    if st.uid() != uid {
        return None;
    }
    if st.mode() & 0o077 != 0 {
        let _ = fd.set_permissions(std::fs::Permissions::from_mode(0o600));
    }
    let mut buf = Vec::new();
    let mut file = fd;
    file.read_to_end(&mut buf).ok()?;
    if buf.len() > max_bytes {
        return None;
    }
    // Node reads as utf8 (lossy decode); lossy conversion keeps parity.
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// JS ensurePrivateDir: mkdir 0700, reject symlink/non-dir/wrong uid,
/// unconditionally tighten to 0700.
pub fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    match std::fs::create_dir_all(dir) {
        Ok(()) => {}
        Err(e) => {
            let _ = e;
            // create_dir_all tolerates existing dirs; other errors surface below
        }
    }
    let st = std::fs::symlink_metadata(dir).map_err(|e| e.to_string())?;
    if !st.is_dir() || st.file_type().is_symlink() {
        return Err(format!(
            "Settings directory is not a regular directory: {}",
            dir.display()
        ));
    }
    let uid = unsafe { libc::getuid() };
    if st.uid() != uid {
        return Err(format!(
            "Settings directory owned by untrusted UID: {}",
            st.uid()
        ));
    }
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    Ok(())
}

/// JS writeAtomicSettings: pretty JSON + trailing \n, size cap, O_EXCL temp
/// file mode 0600, fdatasync, rename, best-effort dir fsync.
pub fn write_atomic_settings(settings: &Value) -> Result<(), String> {
    let content = format!("{}\n", serde_json::to_string_pretty(settings).unwrap());
    if content.len() > MAX_SETTINGS_BYTES {
        return Err("Settings payload exceeds size limit".into());
    }

    let settings_path = get_settings_path();
    let dir_path = settings_path
        .parent()
        .ok_or("Settings path has no parent directory")?
        .to_path_buf();
    ensure_private_dir(&dir_path)?;

    let tmp_path = dir_path.join(format!(".settings.{}.tmp", rand_hex(6)));
    let mut fd = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp_path)
        .map_err(|e| e.to_string())?;
    let write_res = (|| -> Result<(), String> {
        fd.write_all(content.as_bytes())
            .map_err(|e| e.to_string())?;
        fd.sync_data().map_err(|e| e.to_string())?;
        Ok(())
    })();
    drop(fd);
    write_res?;
    std::fs::rename(&tmp_path, &settings_path).map_err(|e| e.to_string())?;

    // Best-effort directory fsync so the rename is durable.
    if let Ok(dir_fd) = OpenOptions::new().read(true).open(&dir_path) {
        let _ = dir_fd.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("hermes-fs-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn read_bounded_file_basics() {
        let d = tmpdir("rbf");
        let f = d.join("valid.txt");
        std::fs::write(&f, "hello hermes").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(read_bounded_file(&f, 1024).as_deref(), Some("hello hermes"));
        assert_eq!(read_bounded_file(&d.join("missing.txt"), 1024), None);
        assert_eq!(read_bounded_file(&f, 5), None);

        let link = d.join("symlink.txt");
        std::os::unix::fs::symlink(&f, &link).unwrap();
        assert_eq!(read_bounded_file(&link, 1024), None);

        // Wider mode gets tightened to 0600.
        let wide = d.join("wide.txt");
        std::fs::write(&wide, "x").unwrap();
        std::fs::set_permissions(&wide, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(read_bounded_file(&wide, 1024).as_deref(), Some("x"));
        assert_eq!(
            std::fs::metadata(&wide).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn ensure_private_dir_basics() {
        let d = tmpdir("epd");
        let sub = d.join("private-sub");
        ensure_private_dir(&sub).unwrap();
        assert_eq!(
            std::fs::symlink_metadata(&sub)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );

        let wide = d.join("wide-sub");
        std::fs::create_dir(&wide).unwrap();
        std::fs::set_permissions(&wide, std::fs::Permissions::from_mode(0o755)).unwrap();
        ensure_private_dir(&wide).unwrap();
        assert_eq!(
            std::fs::symlink_metadata(&wide)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );

        let link = d.join("symlink-dir");
        std::os::unix::fs::symlink(&sub, &link).unwrap();
        assert!(ensure_private_dir(&link)
            .unwrap_err()
            .contains("not a regular directory"));
        let _ = std::fs::remove_dir_all(&d);
    }
}
