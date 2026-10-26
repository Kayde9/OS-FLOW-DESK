//! ETW providers FlowDesk can enable. GUIDs and keyword bits were checked
//! against `logman query providers` / `wevtutil gp` on Windows 11 (26200).
//! Event and field names are never hard-coded for display: they come from
//! the provider's manifest through TDH at run time.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Process,
    Disk,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDef {
    pub id: &'static str,
    pub name: &'static str,
    #[serde(skip)]
    pub kind: Kind,
    #[serde(serialize_with = "ser_guid")]
    pub guid: u128,
    #[serde(skip)]
    pub keywords: u64,
    pub categories: &'static [&'static str],
    pub description: &'static str,
    pub attribution: &'static str,
}

fn ser_guid<S: serde::Serializer>(g: &u128, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&guid_string(*g))
}

pub fn guid_string(g: u128) -> String {
    format!(
        "{{{:08X}-{:04X}-{:04X}-{:04X}-{:012X}}}",
        (g >> 96) as u32,
        (g >> 80) as u16,
        (g >> 64) as u16,
        (g >> 48) as u16,
        g & 0xFFFF_FFFF_FFFF
    )
}

// Microsoft-Windows-Kernel-File keywords
pub const KF_FILEIO: u64 = 0x20;
pub const KF_OP_END: u64 = 0x40;
pub const KF_CREATE: u64 = 0x80;
pub const KF_READ: u64 = 0x100;
pub const KF_WRITE: u64 = 0x200;
pub const KF_DELETE_PATH: u64 = 0x400;
pub const KF_RENAME_SETLINK_PATH: u64 = 0x800;
pub const KF_CREATE_NEW_FILE: u64 = 0x1000;

pub const FILE: ProviderDef = ProviderDef {
    id: "file",
    name: "Microsoft-Windows-Kernel-File",
    kind: Kind::File,
    guid: 0xEDD08927_9CC4_4E65_B970_C2560FB5C289,
    keywords: KF_CREATE | KF_READ | KF_WRITE | KF_DELETE_PATH | KF_RENAME_SETLINK_PATH | KF_CREATE_NEW_FILE,
    categories: &["file"],
    description: "File-system requests seen by the I/O manager: create/open, read, write, delete and rename paths. Optional: OperationEnd completions (duration + NTSTATUS) and handle/metadata events.",
    attribution: "Event header process id; completions matched to requests by IRP pointer.",
};

pub const PROCESS: ProviderDef = ProviderDef {
    id: "process",
    name: "Microsoft-Windows-Kernel-Process",
    kind: Kind::Process,
    guid: 0x22FB2CD6_0E7B_422B_A0C7_2FAD1FD0E716,
    // WINEVENT_KEYWORD_PROCESS | THREAD | IMAGE
    keywords: 0x10 | 0x20 | 0x40,
    categories: &["process", "thread", "image"],
    description: "Process start/stop, thread start/stop and image (DLL/EXE) load/unload.",
    attribution: "ProcessID / ParentProcessID payload fields, or the event header process id.",
};

pub const DISK: ProviderDef = ProviderDef {
    id: "disk",
    name: "Microsoft-Windows-Kernel-Disk",
    kind: Kind::Disk,
    guid: 0xC7BDE69A_E1E0_4177_B6EF_283AD1525271,
    // The provider defines only its Analytic channel keyword.
    keywords: 0x8000_0000_0000_0000,
    categories: &["disk"],
    description: "Physical disk read, write and flush requests below the file-system cache.",
    attribution: "Header process id, or a FileObject the target opened during capture. Cached reads cause no disk I/O, and cache write-back by the System process is not attributed.",
};

pub const ALL: [ProviderDef; 3] = [FILE, PROCESS, DISK];

pub fn find(id: &str) -> Option<&'static ProviderDef> {
    ALL.iter().find(|p| p.id == id)
}

pub fn by_guid(g: u128) -> Option<&'static ProviderDef> {
    ALL.iter().find(|p| p.guid == g)
}

/// Common NTSTATUS values (ntstatus.h) so results read as names; anything else
/// is shown as its hex code only.
pub fn ntstatus_name(code: u32) -> Option<&'static str> {
    Some(match code {
        0x0000_0000 => "STATUS_SUCCESS",
        0x0000_0103 => "STATUS_PENDING",
        0x0000_0104 => "STATUS_REPARSE",
        0x8000_0005 => "STATUS_BUFFER_OVERFLOW",
        0x8000_0006 => "STATUS_NO_MORE_FILES",
        0xC000_000D => "STATUS_INVALID_PARAMETER",
        0xC000_000F => "STATUS_NO_SUCH_FILE",
        0xC000_0010 => "STATUS_INVALID_DEVICE_REQUEST",
        0xC000_0011 => "STATUS_END_OF_FILE",
        0xC000_0022 => "STATUS_ACCESS_DENIED",
        0xC000_0023 => "STATUS_BUFFER_TOO_SMALL",
        0xC000_0033 => "STATUS_OBJECT_NAME_INVALID",
        0xC000_0034 => "STATUS_OBJECT_NAME_NOT_FOUND",
        0xC000_0035 => "STATUS_OBJECT_NAME_COLLISION",
        0xC000_003A => "STATUS_OBJECT_PATH_NOT_FOUND",
        0xC000_0043 => "STATUS_SHARING_VIOLATION",
        0xC000_0056 => "STATUS_DELETE_PENDING",
        0xC000_00BA => "STATUS_FILE_IS_A_DIRECTORY",
        0xC000_00BB => "STATUS_NOT_SUPPORTED",
        0xC000_0103 => "STATUS_NOT_A_DIRECTORY",
        0xC000_0120 => "STATUS_CANCELLED",
        _ => return None,
    })
}

/// NT_SUCCESS / NT_INFORMATION are not failures; NT_WARNING and NT_ERROR are.
pub fn ntstatus_class(code: u32) -> &'static str {
    match code >> 30 {
        0 | 1 => "success",
        2 => "warning",
        _ => "error",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guid_formatting_and_lookup() {
        assert_eq!(guid_string(FILE.guid), "{EDD08927-9CC4-4E65-B970-C2560FB5C289}");
        assert_eq!(guid_string(PROCESS.guid), "{22FB2CD6-0E7B-422B-A0C7-2FAD1FD0E716}");
        assert_eq!(by_guid(DISK.guid).unwrap().id, "disk");
        assert_eq!(ntstatus_class(0), "success");
        assert_eq!(ntstatus_class(0x8000_0006), "warning");
        assert_eq!(ntstatus_class(0xC000_0034), "error");
        assert_eq!(ntstatus_name(0xC000_0011), Some("STATUS_END_OF_FILE"));
    }
}
