//! Schema-driven payload decoding. The property layout of each (provider,
//! event id, version) is obtained from TDH once (see `etw.rs`); payloads are
//! then walked with that layout. Properties the walker cannot size safely
//! (structs, variable arrays, unknown types) stop decoding and are reported as
//! undecoded rather than guessed.

use serde_json::{json, Value};

// TDH_INTYPE_* (tdh.h)
const UNICODESTRING: u16 = 1;
const ANSISTRING: u16 = 2;
const INT8: u16 = 3;
const UINT8: u16 = 4;
const INT16: u16 = 5;
const UINT16: u16 = 6;
const INT32: u16 = 7;
const UINT32: u16 = 8;
const INT64: u16 = 9;
const UINT64: u16 = 10;
const FLOAT: u16 = 11;
const DOUBLE: u16 = 12;
const BOOLEAN: u16 = 13;
const BINARY: u16 = 14;
const GUID: u16 = 15;
const POINTER: u16 = 16;
const FILETIME: u16 = 17;
const SYSTEMTIME: u16 = 18;
const SID: u16 = 19;
const HEXINT32: u16 = 20;
const HEXINT64: u16 = 21;
const SIZET: u16 = 308;
const WBEMSID: u16 = 310;
// TDH_OUTTYPE_* that should render as hex
const OUT_HEX: [u16; 6] = [16, 17, 18, 19, 31, 32]; // HEXINT8..64, NTSTATUS, HRESULT

// PROPERTY_FLAGS
const PROP_STRUCT: i32 = 1;
const PROP_PARAM_LENGTH: i32 = 2;
const PROP_PARAM_COUNT: i32 = 4;

#[derive(Debug, Clone)]
pub struct PropDef {
    pub name: String,
    pub in_type: u16,
    pub out_type: u16,
    pub flags: i32,
    /// Fixed element count, or (with PROP_PARAM_COUNT) the index of the count property.
    pub count: u16,
    /// Fixed length, or (with PROP_PARAM_LENGTH) the index of the length property.
    pub length: u16,
}

#[derive(Debug, Clone, Default)]
pub struct Layout {
    pub provider_name: Option<String>,
    pub event_name: Option<String>,
    pub task_name: Option<String>,
    pub opcode_name: Option<String>,
    pub props: Vec<PropDef>,
}

impl Layout {
    /// Display name: manifest event name, else task (+ opcode), else the numeric id.
    pub fn display_name(&self, id: u16) -> String {
        if let Some(n) = self.event_name.as_ref().filter(|s| !s.is_empty()) {
            return n.clone();
        }
        match (&self.task_name, &self.opcode_name) {
            (Some(t), Some(o)) if !t.is_empty() && !o.is_empty() && o != "Info" && !t.ends_with(o.as_str()) => format!("{t}/{o}"),
            (Some(t), _) if !t.is_empty() => t.clone(),
            _ => format!("Event {id}"),
        }
    }
    /// The schema as discovered, for the session's verification record.
    pub fn describe(&self, provider: &str, id: u16, version: u8) -> super::model::SchemaInfo {
        super::model::SchemaInfo {
            provider: self.provider_name.clone().unwrap_or_else(|| provider.to_string()),
            event_id: id,
            version,
            name: self.display_name(id),
            fields: self.props.iter().map(|p| format!("{}:{}", p.name, type_name(p.in_type))).collect(),
        }
    }
}

fn type_name(t: u16) -> String {
    match t {
        UNICODESTRING => "UnicodeString".into(),
        ANSISTRING => "AnsiString".into(),
        INT8 => "Int8".into(),
        UINT8 => "UInt8".into(),
        INT16 => "Int16".into(),
        UINT16 => "UInt16".into(),
        INT32 => "Int32".into(),
        UINT32 => "UInt32".into(),
        INT64 => "Int64".into(),
        UINT64 => "UInt64".into(),
        FLOAT => "Float".into(),
        DOUBLE => "Double".into(),
        BOOLEAN => "Boolean".into(),
        BINARY => "Binary".into(),
        GUID => "GUID".into(),
        POINTER => "Pointer".into(),
        FILETIME => "FILETIME".into(),
        SYSTEMTIME => "SYSTEMTIME".into(),
        SID => "SID".into(),
        HEXINT32 => "HexInt32".into(),
        HEXINT64 => "HexInt64".into(),
        SIZET => "SizeT".into(),
        WBEMSID => "WbemSid".into(),
        other => format!("type{other}"),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Val {
    U(u64),
    I(i64),
    F(f64),
    Hex(u64),
    S(String),
    B(bool),
    Guid(String),
    Bytes(String),
}

impl Val {
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Val::U(v) | Val::Hex(v) => Some(*v),
            Val::I(v) if *v >= 0 => Some(*v as u64),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Val::S(s) => Some(s),
            _ => None,
        }
    }
    pub fn to_json(&self) -> Value {
        match self {
            // Beyond 2^53 a JS number loses precision; keep those as strings.
            Val::U(v) if *v > (1u64 << 53) => json!(v.to_string()),
            Val::U(v) => json!(v),
            Val::I(v) => json!(v),
            Val::F(v) => json!(v),
            Val::Hex(v) => json!(format!("0x{v:X}")),
            Val::S(s) | Val::Guid(s) | Val::Bytes(s) => json!(s),
            Val::B(b) => json!(b),
        }
    }
}

#[derive(Debug, Default)]
pub struct Decoded {
    pub fields: Vec<(String, Val)>,
    /// Why decoding stopped early, if it did.
    pub incomplete: Option<String>,
}

impl Decoded {
    pub fn get(&self, name: &str) -> Option<&Val> {
        self.fields.iter().find(|(n, _)| n == name).map(|(_, v)| v)
    }
    pub fn u64(&self, name: &str) -> Option<u64> {
        self.get(name).and_then(Val::as_u64)
    }
    pub fn str(&self, name: &str) -> Option<&str> {
        self.get(name).and_then(Val::as_str)
    }
}

struct Reader<'a> {
    d: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let s = self.d.get(self.at..self.at.checked_add(n)?)?;
        self.at += n;
        Some(s)
    }
    fn uint(&mut self, n: usize) -> Option<u64> {
        let b = self.take(n)?;
        let mut v = 0u64;
        for (i, x) in b.iter().enumerate() {
            v |= (*x as u64) << (8 * i);
        }
        Some(v)
    }
    fn wstr(&mut self, fixed_chars: Option<usize>) -> Option<String> {
        let rest = &self.d[self.at..];
        let units: Vec<u16> = rest.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let (len, consumed) = match fixed_chars {
            Some(n) => {
                let n = n.min(units.len());
                (units[..n].iter().position(|&u| u == 0).unwrap_or(n), n)
            }
            None => match units.iter().position(|&u| u == 0) {
                Some(p) => (p, p + 1),
                None => (units.len(), units.len()), // unterminated final string
            },
        };
        self.at += consumed * 2;
        Some(String::from_utf16_lossy(&units[..len]))
    }
    fn astr(&mut self) -> Option<String> {
        let rest = &self.d[self.at..];
        let (len, consumed) = match rest.iter().position(|&b| b == 0) {
            Some(p) => (p, p + 1),
            None => (rest.len(), rest.len()),
        };
        self.at += consumed;
        Some(String::from_utf8_lossy(&rest[..len]).into_owned())
    }
}

fn sid_string(b: &[u8]) -> String {
    // S-R-I-S-S… (revision, 6-byte big-endian authority, little-endian sub-authorities)
    let auth = b[2..8].iter().fold(0u64, |a, x| (a << 8) | *x as u64);
    let mut s = format!("S-{}-{auth}", b[0]);
    for c in b[8..].chunks_exact(4) {
        s.push_str(&format!("-{}", u32::from_le_bytes([c[0], c[1], c[2], c[3]])));
    }
    s
}

fn hex_bytes(b: &[u8]) -> String {
    const MAX: usize = 64;
    let mut s = String::from("0x");
    for x in b.iter().take(MAX) {
        s.push_str(&format!("{x:02X}"));
    }
    if b.len() > MAX {
        s.push('…');
    }
    s
}

/// Walks `data` using `layout`. `ptr` is the pointer size of the event (4 or 8).
pub fn decode(layout: &Layout, data: &[u8], ptr: usize) -> Decoded {
    let mut out = Decoded::default();
    let mut r = Reader { d: data, at: 0 };
    for (i, p) in layout.props.iter().enumerate() {
        if p.flags & PROP_STRUCT != 0 {
            out.incomplete = Some(format!("structured property '{}' not decoded", p.name));
            break;
        }
        let count_is_param = p.flags & PROP_PARAM_COUNT != 0;
        if count_is_param || p.count > 1 {
            out.incomplete = Some(format!("array property '{}' not decoded", p.name));
            break;
        }
        // Length taken from an earlier property (binary blobs, counted strings).
        let length = if p.flags & PROP_PARAM_LENGTH != 0 {
            match layout.props.get(p.length as usize).and_then(|lp| out.get(&lp.name)).and_then(Val::as_u64) {
                Some(n) => Some(n as usize),
                None => {
                    out.incomplete = Some(format!("length of '{}' unavailable", p.name));
                    break;
                }
            }
        } else if p.length > 0 {
            Some(p.length as usize)
        } else {
            None
        };
        let hex = OUT_HEX.contains(&p.out_type);
        let num = |v: u64| if hex { Val::Hex(v) } else { Val::U(v) };
        let v = match p.in_type {
            UNICODESTRING => r.wstr(length).map(Val::S),
            ANSISTRING => r.astr().map(Val::S),
            INT8 => r.uint(1).map(|v| Val::I(v as u8 as i8 as i64)),
            UINT8 => r.uint(1).map(num),
            INT16 => r.uint(2).map(|v| Val::I(v as u16 as i16 as i64)),
            UINT16 => r.uint(2).map(num),
            INT32 => r.uint(4).map(|v| Val::I(v as u32 as i32 as i64)),
            UINT32 => r.uint(4).map(num),
            HEXINT32 => r.uint(4).map(Val::Hex),
            INT64 => r.uint(8).map(|v| Val::I(v as i64)),
            UINT64 => r.uint(8).map(num),
            HEXINT64 => r.uint(8).map(Val::Hex),
            POINTER | SIZET => r.uint(ptr).map(Val::Hex),
            FLOAT => r.uint(4).map(|v| Val::F(f32::from_bits(v as u32) as f64)),
            DOUBLE => r.uint(8).map(|v| Val::F(f64::from_bits(v))),
            BOOLEAN => r.uint(4).map(|v| Val::B(v != 0)),
            FILETIME => r.uint(8).map(|v| Val::I(filetime_to_unix_us(v as i64))),
            GUID => r.take(16).map(|b| {
                // GUID memory layout: Data1..3 little-endian, Data4 as bytes.
                let d1 = u32::from_le_bytes(b[0..4].try_into().unwrap());
                let d2 = u16::from_le_bytes(b[4..6].try_into().unwrap());
                let d3 = u16::from_le_bytes(b[6..8].try_into().unwrap());
                Val::Guid(format!(
                    "{{{d1:08X}-{d2:04X}-{d3:04X}-{:02X}{:02X}-{}}}",
                    b[8],
                    b[9],
                    b[10..16].iter().map(|x| format!("{x:02X}")).collect::<String>()
                ))
            }),
            SYSTEMTIME => r.take(16).map(|b| {
                let w = |i: usize| u16::from_le_bytes([b[i * 2], b[i * 2 + 1]]);
                Val::S(format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}", w(0), w(1), w(3), w(4), w(5), w(6), w(7)))
            }),
            SID | WBEMSID => {
                if p.in_type == WBEMSID && r.take(ptr * 2).is_none() {
                    None
                } else {
                    let rest = &data[r.at..];
                    if rest.len() < 8 {
                        None
                    } else {
                        let n = 8 + 4 * rest[1] as usize;
                        r.take(n).filter(|b| b.len() == n).map(|b| Val::S(sid_string(b)))
                    }
                }
            }
            BINARY => match length {
                Some(n) => r.take(n).map(|b| Val::Bytes(hex_bytes(b))),
                None => {
                    out.incomplete = Some(format!("binary property '{}' has no length", p.name));
                    break;
                }
            },
            other => {
                out.incomplete = Some(format!("property '{}' has unsupported type {other}", p.name));
                break;
            }
        };
        match v {
            Some(v) => out.fields.push((p.name.clone(), v)),
            None => {
                // Older event versions may omit trailing properties.
                if r.at < data.len() || i == 0 {
                    out.incomplete = Some(format!("payload ended before '{}'", p.name));
                }
                break;
            }
        }
    }
    out
}

/// FILETIME (100 ns since 1601-01-01 UTC) → Unix epoch microseconds.
pub fn filetime_to_unix_us(ft: i64) -> i64 {
    (ft - 116_444_736_000_000_000) / 10
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn prop(name: &str, in_type: u16, out_type: u16) -> PropDef {
        PropDef { name: name.into(), in_type, out_type, flags: 0, count: 1, length: 0 }
    }

    pub fn wide(s: &str) -> Vec<u8> {
        s.encode_utf16().chain([0]).flat_map(|u| u.to_le_bytes()).collect()
    }

    #[test]
    fn decodes_kernel_file_create_shape() {
        // Shape of a Kernel-File Create: pointers, ints and a trailing path.
        let layout = Layout {
            task_name: Some("Create".into()),
            props: vec![
                prop("Irp", POINTER, 0),
                prop("FileObject", POINTER, 0),
                prop("IssuingThreadId", UINT32, 0),
                prop("CreateOptions", UINT32, 18),
                prop("FileName", UNICODESTRING, 0),
            ],
            ..Default::default()
        };
        let mut d = Vec::new();
        d.extend(0xFFFF_A001_u64.to_le_bytes());
        d.extend(0xFFFF_B002_u64.to_le_bytes());
        d.extend(4321u32.to_le_bytes());
        d.extend(0x0100_0060u32.to_le_bytes());
        d.extend(wide("\\Device\\HarddiskVolume3\\x\\a.bin"));
        let r = decode(&layout, &d, 8);
        assert!(r.incomplete.is_none());
        assert_eq!(r.u64("Irp"), Some(0xFFFF_A001));
        assert_eq!(r.u64("IssuingThreadId"), Some(4321));
        assert_eq!(r.get("CreateOptions"), Some(&Val::Hex(0x0100_0060)));
        assert_eq!(r.str("FileName"), Some("\\Device\\HarddiskVolume3\\x\\a.bin"));
        assert_eq!(layout.display_name(12), "Create");
    }

    #[test]
    fn stops_at_struct_and_short_payload_without_guessing() {
        let mut s = prop("Blob", 0, 0);
        s.flags = PROP_STRUCT;
        let layout = Layout { props: vec![prop("A", UINT32, 0), s, prop("B", UINT32, 0)], ..Default::default() };
        let r = decode(&layout, &[1, 0, 0, 0, 9, 9, 9, 9], 8);
        assert_eq!(r.fields.len(), 1);
        assert!(r.incomplete.unwrap().contains("Blob"));

        let layout = Layout { props: vec![prop("A", UINT64, 0)], ..Default::default() };
        let r = decode(&layout, &[1, 2, 3], 8);
        assert!(r.fields.is_empty() && r.incomplete.is_some());
        assert_eq!(Layout::default().display_name(10), "Event 10");
    }

    #[test]
    fn filetime_epoch() {
        assert_eq!(filetime_to_unix_us(116_444_736_000_000_000), 0);
        assert_eq!(filetime_to_unix_us(116_444_736_000_000_000 + 10_000_000), 1_000_000);
    }
}
