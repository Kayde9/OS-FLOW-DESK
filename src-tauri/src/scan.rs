//! Folder traversal used both for the Workspace preview scan and to build a
//! task's work list.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;
use walkdir::WalkDir;

/// Hard cap so a mis-selected drive root cannot exhaust memory.
pub const MAX_FILES: usize = 250_000;

#[derive(Debug, Clone)]
pub struct FileEntry {
    pub path: PathBuf,
    /// Path relative to the selected folder, with forward slashes.
    pub rel: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtCount {
    pub ext: String,
    pub files: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub path: String,
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
    pub errors: u64,
    pub error_samples: Vec<String>,
    pub truncated: bool,
    pub duration_ms: u64,
    pub largest: Vec<(String, u64)>,
    pub extensions: Vec<ExtCount>,
    /// Number of files whose size is shared with another file (duplicate-detection candidates).
    pub size_collisions: u64,
}

pub fn extension(rel: &str) -> String {
    Path::new(rel)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "(none)".into())
}

pub fn walk(root: &Path) -> Result<(Vec<FileEntry>, ScanSummary), String> {
    let started = Instant::now();
    let meta = std::fs::metadata(root).map_err(|e| format!("Cannot open {}: {e}", root.display()))?;
    if !meta.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let mut files = Vec::new();
    let mut dirs = 0u64;
    let mut errors = 0u64;
    let mut error_samples = Vec::new();
    let mut truncated = false;
    for entry in WalkDir::new(root).follow_links(false) {
        match entry {
            Ok(e) => {
                let ft = e.file_type();
                if ft.is_dir() {
                    dirs += 1;
                } else if ft.is_file() {
                    if files.len() >= MAX_FILES {
                        truncated = true;
                        break;
                    }
                    match e.metadata() {
                        Ok(m) => {
                            let rel = e
                                .path()
                                .strip_prefix(root)
                                .unwrap_or(e.path())
                                .to_string_lossy()
                                .replace('\\', "/");
                            files.push(FileEntry { path: e.path().to_path_buf(), rel, size: m.len() });
                        }
                        Err(err) => {
                            errors += 1;
                            if error_samples.len() < 20 {
                                error_samples.push(err.to_string());
                            }
                        }
                    }
                }
            }
            Err(err) => {
                errors += 1;
                if error_samples.len() < 20 {
                    error_samples.push(err.to_string());
                }
            }
        }
    }
    let bytes = files.iter().map(|f| f.size).sum();
    let mut by_ext: HashMap<String, (u64, u64)> = HashMap::new();
    let mut by_size: HashMap<u64, u64> = HashMap::new();
    for f in &files {
        let e = by_ext.entry(extension(&f.rel)).or_default();
        e.0 += 1;
        e.1 += f.size;
        *by_size.entry(f.size).or_default() += 1;
    }
    let mut extensions: Vec<ExtCount> =
        by_ext.into_iter().map(|(ext, (files, bytes))| ExtCount { ext, files, bytes }).collect();
    extensions.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    extensions.truncate(8);
    let mut largest: Vec<(String, u64)> = files.iter().map(|f| (f.rel.clone(), f.size)).collect();
    largest.sort_by(|a, b| b.1.cmp(&a.1));
    largest.truncate(5);
    let size_collisions = files.iter().filter(|f| f.size > 0 && by_size[&f.size] > 1).count() as u64;
    let summary = ScanSummary {
        path: root.to_string_lossy().into_owned(),
        files: files.len() as u64,
        dirs: dirs.saturating_sub(1),
        bytes,
        errors,
        error_samples,
        truncated,
        duration_ms: started.elapsed().as_millis() as u64,
        largest,
        extensions,
        size_collisions,
    };
    Ok((files, summary))
}
