//! File operations, executed one *unit* (file) at a time. Content operations
//! keep their state in a [`Cursor`] so a unit can be preempted after a time
//! quantum and resumed later by any worker (Round Robin).

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::JobShared;
use crate::scan::{extension, FileEntry};
use crate::util::{csv_field, hex, now_ms, system_time_ms};

const CHUNK: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    Hash,
    Index,
    Duplicates,
    Metadata,
    Copy,
}

impl Op {
    pub fn as_str(self) -> &'static str {
        match self {
            Op::Hash => "hash",
            Op::Index => "index",
            Op::Duplicates => "duplicates",
            Op::Metadata => "metadata",
            Op::Copy => "copy",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Op::Hash => "SHA-256 hashing",
            Op::Index => "File indexing",
            Op::Duplicates => "Duplicate detection",
            Op::Metadata => "Metadata analysis",
            Op::Copy => "Safe copy",
        }
    }
    /// Operations that read file contents (progress is measured in bytes).
    pub fn reads_content(self) -> bool {
        matches!(self, Op::Hash | Op::Duplicates | Op::Copy)
    }
}

#[derive(Debug, Clone)]
pub enum FileResult {
    Hash { rel: String, size: u64, sha256: String },
    Stat { rel: String, size: u64, modified: Option<i64>, created: Option<i64>, readonly: bool },
    Copied { rel: String, size: u64, sha256: String },
}

enum CState {
    New,
    Hashing { f: File, h: Sha256 },
    Copying { src: File, dst: File, part: PathBuf, fin: PathBuf, h: Sha256 },
    Verifying { f: File, h: Sha256, expected: Vec<u8>, part: PathBuf, fin: PathBuf },
}

pub struct Cursor {
    pub entry: FileEntry,
    /// Source bytes consumed so far.
    pub read: u64,
    state: CState,
}

impl Cursor {
    pub fn new(entry: FileEntry) -> Self {
        Cursor { entry, read: 0, state: CState::New }
    }
    fn cleanup(&mut self) {
        if let CState::Copying { part, .. } | CState::Verifying { part, .. } = &self.state {
            let part = part.clone();
            self.state = CState::New; // closes handles before deleting
            let _ = fs::remove_file(part);
        }
    }
}

/// A cursor dropped mid-copy (e.g. its task was cancelled while it was queued)
/// must not leave a partial file behind.
impl Drop for Cursor {
    fn drop(&mut self) {
        self.cleanup();
    }
}

pub enum Outcome {
    Done(FileResult),
    Skipped { reason: String, unread: u64 },
    Failed { error: String, unread: u64 },
    /// Quantum expired; resume later.
    Preempted(Cursor),
    /// Task paused; resume at the front of the queue.
    Paused(Cursor),
    Cancelled,
}

pub struct Ctx {
    pub op: Op,
    pub dest: Option<PathBuf>,
}

fn fail(c: &mut Cursor, err: impl std::fmt::Display) -> Outcome {
    c.cleanup();
    Outcome::Failed { error: format!("{}: {err}", c.entry.rel), unread: c.entry.size.saturating_sub(c.read) }
}

pub fn run_unit(ctx: &Ctx, mut c: Cursor, shared: &JobShared, budget: Option<Duration>) -> Outcome {
    let start = Instant::now();
    let mut buf = vec![0u8; CHUNK];
    loop {
        if shared.cancel.load(Ordering::Relaxed) {
            c.cleanup();
            return Outcome::Cancelled;
        }
        if shared.pause.load(Ordering::Relaxed) {
            return Outcome::Paused(c);
        }
        let state = std::mem::replace(&mut c.state, CState::New);
        c.state = match state {
            CState::New => match ctx.op {
                Op::Index | Op::Metadata => {
                    return match fs::metadata(&c.entry.path) {
                        Ok(m) => Outcome::Done(FileResult::Stat {
                            rel: c.entry.rel.clone(),
                            size: m.len(),
                            modified: system_time_ms(m.modified()),
                            created: system_time_ms(m.created()),
                            readonly: m.permissions().readonly(),
                        }),
                        Err(e) => fail(&mut c, e),
                    };
                }
                Op::Hash | Op::Duplicates => match File::open(&c.entry.path) {
                    Ok(f) => CState::Hashing { f, h: Sha256::new() },
                    Err(e) => return fail(&mut c, e),
                },
                Op::Copy => {
                    let dest = ctx.dest.as_ref().expect("copy requires destination");
                    let fin = dest.join(&c.entry.rel);
                    if fin.exists() {
                        return Outcome::Skipped {
                            reason: format!("{}: already exists at destination (never overwritten)", c.entry.rel),
                            unread: c.entry.size,
                        };
                    }
                    if let Some(parent) = fin.parent() {
                        if let Err(e) = fs::create_dir_all(parent) {
                            return fail(&mut c, e);
                        }
                    }
                    let part = PathBuf::from(format!("{}.flowdesk-part", fin.display()));
                    let src = match File::open(&c.entry.path) {
                        Ok(f) => f,
                        Err(e) => return fail(&mut c, e),
                    };
                    match OpenOptions::new().write(true).create(true).truncate(true).open(&part) {
                        Ok(dst) => CState::Copying { src, dst, part, fin, h: Sha256::new() },
                        Err(e) => return fail(&mut c, e),
                    }
                }
            },
            CState::Hashing { mut f, mut h } => match f.read(&mut buf) {
                Ok(0) => {
                    return Outcome::Done(FileResult::Hash {
                        rel: c.entry.rel.clone(),
                        size: c.read,
                        sha256: hex(&h.finalize()),
                    })
                }
                Ok(n) => {
                    h.update(&buf[..n]);
                    c.read += n as u64;
                    shared.bytes_done.fetch_add(n as u64, Ordering::Relaxed);
                    CState::Hashing { f, h }
                }
                Err(e) => return fail(&mut c, e),
            },
            CState::Copying { mut src, mut dst, part, fin, mut h } => match src.read(&mut buf) {
                Ok(0) => {
                    if let Err(e) = dst.flush().and_then(|_| dst.sync_all()) {
                        c.state = CState::Copying { src, dst, part, fin, h };
                        return fail(&mut c, e);
                    }
                    drop(dst);
                    drop(src);
                    match File::open(&part) {
                        Ok(f) => CState::Verifying { f, h: Sha256::new(), expected: h.finalize().to_vec(), part, fin },
                        Err(e) => {
                            let _ = fs::remove_file(&part);
                            return fail(&mut c, e);
                        }
                    }
                }
                Ok(n) => {
                    h.update(&buf[..n]);
                    if let Err(e) = dst.write_all(&buf[..n]) {
                        c.state = CState::Copying { src, dst, part, fin, h };
                        return fail(&mut c, e);
                    }
                    c.read += n as u64;
                    shared.bytes_done.fetch_add(n as u64, Ordering::Relaxed);
                    CState::Copying { src, dst, part, fin, h }
                }
                Err(e) => {
                    c.state = CState::Copying { src, dst, part, fin, h };
                    return fail(&mut c, e);
                }
            },
            CState::Verifying { mut f, mut h, expected, part, fin } => match f.read(&mut buf) {
                Ok(0) => {
                    drop(f);
                    let actual = h.finalize().to_vec();
                    if actual != expected {
                        let _ = fs::remove_file(&part);
                        return Outcome::Failed {
                            error: format!("{}: verification hash mismatch — copy discarded", c.entry.rel),
                            unread: 0,
                        };
                    }
                    // A file that appeared at the destination meanwhile is never replaced.
                    if fin.exists() {
                        let _ = fs::remove_file(&part);
                        return Outcome::Skipped {
                            reason: format!("{}: destination appeared during copy (not overwritten)", c.entry.rel),
                            unread: 0,
                        };
                    }
                    return match fs::rename(&part, &fin) {
                        Ok(()) => Outcome::Done(FileResult::Copied {
                            rel: c.entry.rel.clone(),
                            size: c.read,
                            sha256: hex(&actual),
                        }),
                        Err(e) => {
                            let _ = fs::remove_file(&part);
                            Outcome::Failed { error: format!("{}: {e}", c.entry.rel), unread: 0 }
                        }
                    };
                }
                Ok(n) => {
                    h.update(&buf[..n]);
                    CState::Verifying { f, h, expected, part, fin }
                }
                Err(e) => {
                    c.state = CState::Verifying { f, h, expected, part, fin };
                    return fail(&mut c, e);
                }
            },
        };
        if let Some(b) = budget {
            if start.elapsed() >= b {
                return Outcome::Preempted(c);
            }
        }
    }
}

/// Metadata that goes into every report header.
pub struct ReportMeta<'a> {
    pub id: i64,
    pub name: &'a str,
    pub op: Op,
    pub folder: &'a Path,
    pub dest: Option<&'a Path>,
    pub policy: &'a str,
    pub status: &'a str,
}

/// Writes the JSON (and CSV where useful) report. Returns (report path, short summary JSON).
pub fn write_report(
    dir: &Path,
    meta: &ReportMeta<'_>,
    results: &[FileResult],
    errors: &[String],
) -> Result<(PathBuf, String), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let base = dir.join(format!("task-{:05}-{}", meta.id, meta.op.as_str()));
    let header = json!({
        "task": meta.id, "name": meta.name, "operation": meta.op.label(),
        "folder": meta.folder.to_string_lossy(), "destination": meta.dest.map(|d| d.to_string_lossy()),
        "policy": meta.policy, "status": meta.status, "generatedAt": now_ms(), "errors": errors,
    });
    let mut csv: Option<String> = None;

    let (summary, body) = match meta.op {
        Op::Hash | Op::Copy => {
            let rows: Vec<_> = results
                .iter()
                .filter_map(|r| match r {
                    FileResult::Hash { rel, size, sha256 } | FileResult::Copied { rel, size, sha256 } => {
                        Some((rel, *size, sha256))
                    }
                    _ => None,
                })
                .collect();
            let mut out = String::from("path,size,sha256\n");
            for (rel, size, sha) in &rows {
                out.push_str(&format!("{},{},{}\n", csv_field(rel), size, sha));
            }
            csv = Some(out);
            let bytes: u64 = rows.iter().map(|r| r.1).sum();
            let s = json!({ "files": rows.len(), "bytes": bytes });
            let body = json!(rows.iter().map(|(p, s, h)| json!({"path": p, "size": s, "sha256": h})).collect::<Vec<_>>());
            (s, body)
        }
        Op::Duplicates => {
            let mut groups: HashMap<&str, Vec<(&str, u64)>> = HashMap::new();
            for r in results {
                if let FileResult::Hash { rel, size, sha256 } = r {
                    groups.entry(sha256.as_str()).or_default().push((rel.as_str(), *size));
                }
            }
            let mut dupes: Vec<_> = groups.into_iter().filter(|(_, v)| v.len() > 1).collect();
            dupes.sort_by(|a, b| (b.1[0].1 * b.1.len() as u64).cmp(&(a.1[0].1 * a.1.len() as u64)));
            let wasted: u64 = dupes.iter().map(|(_, v)| v[0].1 * (v.len() as u64 - 1)).sum();
            let files: usize = dupes.iter().map(|(_, v)| v.len()).sum();
            let mut out = String::from("group,sha256,size,path\n");
            for (i, (h, v)) in dupes.iter().enumerate() {
                for (p, s) in v {
                    out.push_str(&format!("{},{},{},{}\n", i + 1, h, s, csv_field(p)));
                }
            }
            csv = Some(out);
            let s = json!({ "groups": dupes.len(), "duplicateFiles": files, "reclaimableBytes": wasted, "hashed": results.len() });
            let body = json!(dupes.iter().map(|(h, v)| json!({"sha256": h, "size": v[0].1,
                "paths": v.iter().map(|x| x.0).collect::<Vec<_>>()})).collect::<Vec<_>>());
            (s, body)
        }
        Op::Index | Op::Metadata => {
            let stats: Vec<_> = results
                .iter()
                .filter_map(|r| match r {
                    FileResult::Stat { rel, size, modified, created, readonly } => Some((rel, *size, *modified, *created, *readonly)),
                    _ => None,
                })
                .collect();
            if meta.op == Op::Index {
                let mut out = String::from("path,extension,size,modified_ms,created_ms,readonly\n");
                for (rel, size, m, c, ro) in &stats {
                    out.push_str(&format!(
                        "{},{},{},{},{},{}\n",
                        csv_field(rel),
                        csv_field(&extension(rel)),
                        size,
                        m.map(|v| v.to_string()).unwrap_or_default(),
                        c.map(|v| v.to_string()).unwrap_or_default(),
                        ro
                    ));
                }
                csv = Some(out);
            }
            let mut ext: HashMap<String, (u64, u64)> = HashMap::new();
            for (rel, size, ..) in &stats {
                let e = ext.entry(extension(rel)).or_default();
                e.0 += 1;
                e.1 += size;
            }
            let mut ext: Vec<_> = ext.into_iter().collect();
            ext.sort_by(|a, b| b.1 .1.cmp(&a.1 .1));
            const SIZE_EDGES: [(u64, &str); 6] = [
                (4 * 1024, "< 4 KB"),
                (64 * 1024, "4–64 KB"),
                (1024 * 1024, "64 KB–1 MB"),
                (16 * 1024 * 1024, "1–16 MB"),
                (256 * 1024 * 1024, "16–256 MB"),
                (u64::MAX, "≥ 256 MB"),
            ];
            let mut size_buckets = vec![0u64; SIZE_EDGES.len()];
            for (_, size, ..) in &stats {
                let i = SIZE_EDGES.iter().position(|(edge, _)| size < edge).unwrap_or(SIZE_EDGES.len() - 1);
                size_buckets[i] += 1;
            }
            let now = now_ms();
            const DAY: i64 = 86_400_000;
            const AGE_EDGES: [(i64, &str); 5] =
                [(DAY, "< 1 day"), (30 * DAY, "< 30 days"), (365 * DAY, "< 1 year"), (5 * 365 * DAY, "< 5 years"), (i64::MAX, "≥ 5 years")];
            let mut age_buckets = vec![0u64; AGE_EDGES.len()];
            for (_, _, m, ..) in &stats {
                if let Some(m) = m {
                    let age = now - m;
                    let i = AGE_EDGES.iter().position(|(edge, _)| age < *edge).unwrap_or(AGE_EDGES.len() - 1);
                    age_buckets[i] += 1;
                }
            }
            let mut largest: Vec<_> = stats.iter().map(|s| (s.0.as_str(), s.1)).collect();
            largest.sort_by(|a, b| b.1.cmp(&a.1));
            largest.truncate(10);
            let readonly = stats.iter().filter(|s| s.4).count();
            let s = json!({
                "files": stats.len(),
                "bytes": stats.iter().map(|s| s.1).sum::<u64>(),
                "readonly": readonly,
                "extensions": ext.iter().take(12).map(|(e, (n, b))| json!({"ext": e, "files": n, "bytes": b})).collect::<Vec<_>>(),
                "sizeBuckets": SIZE_EDGES.iter().zip(&size_buckets).map(|((_, l), n)| json!({"label": l, "files": n})).collect::<Vec<_>>(),
                "ageBuckets": AGE_EDGES.iter().zip(&age_buckets).map(|((_, l), n)| json!({"label": l, "files": n})).collect::<Vec<_>>(),
                "largest": largest.iter().map(|(p, s)| json!({"path": p, "size": s})).collect::<Vec<_>>(),
            });
            let body = if meta.op == Op::Index {
                json!(stats.iter().map(|(p, s, m, c, ro)| json!({"path": p, "size": s, "modified": m, "created": c, "readonly": ro})).collect::<Vec<_>>())
            } else {
                s.clone()
            };
            (s, body)
        }
    };

    let report = json!({ "header": header, "summary": summary, "results": body });
    let json_path = base.with_extension("json");
    fs::write(&json_path, serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?)
        .map_err(|e| format!("writing report: {e}"))?;
    if let Some(csv) = csv {
        fs::write(base.with_extension("csv"), csv).map_err(|e| format!("writing CSV: {e}"))?;
    }
    Ok((json_path, summary.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64};

    fn shared() -> JobShared {
        JobShared { bytes_done: AtomicU64::new(0), cancel: AtomicBool::new(false), pause: AtomicBool::new(false) }
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("flowdesk-ops-{tag}-{}-{}", std::process::id(), now_ms()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn sha256_known_vector_and_preemption() {
        let d = tmpdir("hash");
        let p = d.join("abc.txt");
        fs::write(&p, b"abc").unwrap();
        let ctx = Ctx { op: Op::Hash, dest: None };
        let s = shared();
        let entry = FileEntry { path: p, rel: "abc.txt".into(), size: 3 };
        // Zero budget: preempted after the first step, then resumed to completion.
        let mut c = Cursor::new(entry);
        let result = loop {
            match run_unit(&ctx, c, &s, Some(Duration::ZERO)) {
                Outcome::Preempted(next) => c = next,
                Outcome::Done(r) => break r,
                _ => panic!("unexpected outcome"),
            }
        };
        match result {
            FileResult::Hash { sha256, .. } => {
                assert_eq!(sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
            }
            _ => panic!(),
        }
        assert_eq!(s.bytes_done.load(Ordering::Relaxed), 3);
    }

    #[test]
    fn copy_verifies_and_never_overwrites() {
        let src = tmpdir("src");
        let dst = tmpdir("dst");
        fs::write(src.join("a.bin"), vec![7u8; 600_000]).unwrap();
        let ctx = Ctx { op: Op::Copy, dest: Some(dst.clone()) };
        let s = shared();
        let entry = FileEntry { path: src.join("a.bin"), rel: "a.bin".into(), size: 600_000 };
        assert!(matches!(run_unit(&ctx, Cursor::new(entry.clone()), &s, None), Outcome::Done(FileResult::Copied { .. })));
        assert_eq!(fs::read(dst.join("a.bin")).unwrap().len(), 600_000);
        assert!(!dst.join("a.bin.flowdesk-part").exists());
        assert!(matches!(run_unit(&ctx, Cursor::new(entry), &s, None), Outcome::Skipped { .. }));
    }

    #[test]
    fn cancel_removes_partial_copy() {
        let src = tmpdir("csrc");
        let dst = tmpdir("cdst");
        fs::write(src.join("big.bin"), vec![1u8; 2_000_000]).unwrap();
        let ctx = Ctx { op: Op::Copy, dest: Some(dst.clone()) };
        let s = shared();
        let entry = FileEntry { path: src.join("big.bin"), rel: "big.bin".into(), size: 2_000_000 };
        let Outcome::Preempted(c) = run_unit(&ctx, Cursor::new(entry), &s, Some(Duration::ZERO)) else { panic!() };
        let Outcome::Preempted(c) = run_unit(&ctx, c, &s, Some(Duration::ZERO)) else { panic!() };
        assert!(dst.join("big.bin.flowdesk-part").exists());
        s.cancel.store(true, Ordering::Relaxed);
        assert!(matches!(run_unit(&ctx, c, &s, None), Outcome::Cancelled));
        assert!(!dst.join("big.bin.flowdesk-part").exists());
        assert!(!dst.join("big.bin").exists());
    }
}
