//! Attachments: pasted and dropped images (docs/design.md#attachments). Each
//! one is a file in the data folder's `attachments/`, named by a hash of its
//! bytes, so the same image is stored once. A draft refers to one with an
//! ordinary markdown image, `![](attachment:<name>)`; the bytes never go into
//! the draft's document, so typing stays as fast as it was.

use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};

/// The URL scheme drafts use for attachments.
pub const SCHEME: &str = "attachment:";
/// The largest attachment accepted.
pub const MAX_BYTES: usize = 32 * 1024 * 1024;
/// Hex digits of the SHA-256 in a name: 128 bits.
const HASH_HEX: usize = 32;

/// The image formats every place a draft is shown can display.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Png,
    Jpeg,
    Gif,
    Webp,
}

impl Kind {
    /// The format of `bytes`, from their first few bytes rather than a name
    /// or a type someone claimed.
    pub fn sniff(bytes: &[u8]) -> Option<Kind> {
        if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            Some(Kind::Png)
        } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            Some(Kind::Jpeg)
        } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
            Some(Kind::Gif)
        } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
            Some(Kind::Webp)
        } else {
            None
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Kind::Png => "png",
            Kind::Jpeg => "jpg",
            Kind::Gif => "gif",
            Kind::Webp => "webp",
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            Kind::Png => "image/png",
            Kind::Jpeg => "image/jpeg",
            Kind::Gif => "image/gif",
            Kind::Webp => "image/webp",
        }
    }

    /// The format an attachment name says it is.
    pub fn of(name: &str) -> Option<Kind> {
        let (hash, ext) = name.split_once('.')?;
        if hash.len() != HASH_HEX || !hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return None;
        }
        [Kind::Png, Kind::Jpeg, Kind::Gif, Kind::Webp].into_iter().find(|k| k.extension() == ext)
    }
}

/// Whether `name` is an attachment's name: 32 lowercase hex digits and one
/// of the extensions above. Nothing else is ever looked up on disk.
pub fn is_name(name: &str) -> bool {
    Kind::of(name).is_some()
}

/// Every `attachment:<name>` in `text`, as (byte offset of the name, name),
/// in order and with repeats. Anywhere in the text counts, code included:
/// for keeping files, a false positive is harmless.
fn occurrences(text: &str) -> impl Iterator<Item = (usize, &str)> {
    text.match_indices(SCHEME).filter_map(move |(i, _)| {
        let start = i + SCHEME.len();
        let rest = &text[start..];
        let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '.')).unwrap_or(rest.len());
        let name = rest[..end].trim_end_matches('.');
        is_name(name).then_some((start, name))
    })
}

/// The names of the attachments `text` refers to, in order, with repeats.
pub fn references(text: &str) -> impl Iterator<Item = &str> {
    occurrences(text).map(|(_, name)| name)
}

/// `text` with each `attachment:<name>` replaced by `to(name)`.
pub fn replace_references(text: &str, to: impl Fn(&str) -> String) -> String {
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    for (start, name) in occurrences(text) {
        out.push_str(&text[copied..start - SCHEME.len()]);
        out.push_str(&to(name));
        copied = start + name.len();
    }
    out.push_str(&text[copied..]);
    out
}

#[derive(Debug, thiserror::Error)]
pub enum AddError {
    #[error("images can be at most {} MB", MAX_BYTES / 1024 / 1024)]
    TooLarge,
    #[error("only PNG, JPEG, GIF and WebP images can be attached")]
    Unsupported,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// The attachments folder.
#[derive(Debug, Clone)]
pub struct Attachments {
    dir: PathBuf,
}

impl Attachments {
    pub fn new(dir: PathBuf) -> Attachments {
        Attachments { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Stores an image and returns its name. The same bytes always get the
    /// same name, and adding them again writes nothing.
    pub fn add(&self, bytes: &[u8]) -> Result<String, AddError> {
        if bytes.len() > MAX_BYTES {
            return Err(AddError::TooLarge);
        }
        let kind = Kind::sniff(bytes).ok_or(AddError::Unsupported)?;
        let hash: String = Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect();
        let name = format!("{}.{}", &hash[..HASH_HEX], kind.extension());
        let path = self.dir.join(&name);
        if path.exists() {
            return Ok(name);
        }
        std::fs::create_dir_all(&self.dir)?;
        // Written beside it and renamed into place, so a crash never leaves
        // half an image under a real name.
        let partial = self.dir.join(format!(".{name}.partial"));
        let written = std::fs::File::create(&partial).and_then(|mut f| {
            f.write_all(bytes)?;
            f.sync_all()
        });
        if let Err(e) = written.and_then(|()| std::fs::rename(&partial, &path)) {
            let _ = std::fs::remove_file(&partial);
            return Err(e.into());
        }
        Ok(name)
    }

    /// Where an attachment is, if `name` is one and it's here.
    pub fn path(&self, name: &str) -> Option<PathBuf> {
        let path = self.dir.join(name);
        (is_name(name) && path.is_file()).then_some(path)
    }

    /// An attachment's format and bytes, if it's here.
    pub fn read(&self, name: &str) -> std::io::Result<Option<(Kind, Vec<u8>)>> {
        let (Some(kind), Some(path)) = (Kind::of(name), self.path(name)) else { return Ok(None) };
        Ok(Some((kind, std::fs::read(path)?)))
    }

    /// The names of every attachment here.
    pub fn list(&self) -> std::io::Result<Vec<String>> {
        let entries = match std::fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut names = Vec::new();
        for entry in entries {
            if let Some(name) = entry?.file_name().to_str().filter(|n| is_name(n)) {
                names.push(name.to_string());
            }
        }
        names.sort();
        Ok(names)
    }

    pub fn remove(&self, name: &str) -> std::io::Result<()> {
        if !is_name(name) {
            return Ok(());
        }
        match std::fs::remove_file(self.dir.join(name)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }

    /// Removes files a crash left partway through `add`.
    pub fn remove_partials(&self) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') && name.ends_with(".partial") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// The smallest PNG, one transparent pixel, for tests here and in export.rs.
#[cfg(test)]
pub(crate) const PIXEL: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49,
    0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x60, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x05, 0x00, 0x01, 0x7a, 0xa8, 0x57,
    0x50, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_formats_from_their_bytes() {
        assert_eq!(Kind::sniff(PIXEL), Some(Kind::Png));
        assert_eq!(Kind::sniff(&[0xff, 0xd8, 0xff, 0xe0]), Some(Kind::Jpeg));
        assert_eq!(Kind::sniff(b"GIF89a..."), Some(Kind::Gif));
        assert_eq!(Kind::sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some(Kind::Webp));
        assert_eq!(Kind::sniff(b"<svg xmlns="), None);
        assert_eq!(Kind::sniff(b""), None);
    }

    #[test]
    fn names_are_a_hash_and_a_known_extension() {
        assert!(is_name("0123456789abcdef0123456789abcdef.png"));
        assert!(is_name("0123456789abcdef0123456789abcdef.webp"));
        assert!(!is_name("0123456789ABCDEF0123456789abcdef.png"));
        assert!(!is_name("0123456789abcdef.png"));
        assert!(!is_name("0123456789abcdef0123456789abcdef.svg"));
        assert!(!is_name("../0123456789abcdef0123456789abc.png"));
        assert!(!is_name("0123456789abcdef0123456789abcdef.png.partial"));
    }

    #[test]
    fn finds_and_replaces_references() {
        let a = "0123456789abcdef0123456789abcdef.png";
        let b = "fedcba9876543210fedcba9876543210.jpg";
        let text = format!(
            "# Shots\n\n![](attachment:{a})\nsee ![x](attachment:{b} \"t\") and attachment:{a}.\n`attachment:nope.png`"
        );
        assert_eq!(references(&text).collect::<Vec<_>>(), [a, b, a]);
        let replaced = replace_references(&text, |n| format!("../attachments/{n}"));
        assert_eq!(
            replaced,
            format!(
                "# Shots\n\n![](../attachments/{a})\nsee ![x](../attachments/{b} \"t\") and ../attachments/{a}.\n`attachment:nope.png`"
            )
        );
        assert_eq!(replace_references("no images", |n| n.to_string()), "no images");
    }

    #[test]
    fn stores_each_image_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = Attachments::new(dir.path().join("attachments"));
        assert!(store.list().unwrap().is_empty(), "no folder yet is no attachments");
        let name = store.add(PIXEL).unwrap();
        assert!(is_name(&name) && name.ends_with(".png"));
        assert_eq!(store.add(PIXEL).unwrap(), name);
        assert_eq!(store.list().unwrap(), std::slice::from_ref(&name));
        assert_eq!(store.read(&name).unwrap().unwrap(), (Kind::Png, PIXEL.to_vec()));
        assert!(store.path("../scratchpad.db").is_none());

        assert!(matches!(store.add(b"<svg/>"), Err(AddError::Unsupported)));
        assert!(matches!(store.add(&vec![0; MAX_BYTES + 1]), Err(AddError::TooLarge)));

        std::fs::write(dir.path().join("attachments").join(format!(".{name}.partial")), b"half").unwrap();
        assert_eq!(store.list().unwrap(), std::slice::from_ref(&name));
        store.remove_partials();
        store.remove(&name).unwrap();
        store.remove(&name).unwrap();
        assert!(std::fs::read_dir(dir.path().join("attachments")).unwrap().next().is_none());
    }
}
