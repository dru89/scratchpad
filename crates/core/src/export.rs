//! Exporting every draft as markdown (docs/design.md#export): a folder per
//! place (Inbox, Archive, Trash), a file per draft named from its title and
//! dated like it, and a `drafts.json` manifest with what the files leave out.
//! Images go in `attachments/`, with each draft's links rewritten to point
//! there. The same entries go to a folder or a zip.

use crate::attachments::{self, Attachments};
use crate::protocol::{DraftState, DraftSummary, EMPTY_TITLE};
use crate::time::{civil, iso8601};
use anyhow::{Context, Result, bail};
use serde_json::json;
use std::collections::{BTreeSet, HashSet};
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Longest file name, in characters, before ".md".
const MAX_STEM: usize = 80;

/// One file of an export, at a path relative to its root.
pub struct Entry {
    pub path: String,
    pub contents: Contents,
    /// Milliseconds since the epoch.
    pub modified: i64,
}

pub enum Contents {
    Bytes(Vec<u8>),
    /// An attachment, copied from where it's kept rather than read into memory.
    File(PathBuf),
}

/// A title made safe to use as a file name on macOS, Linux and Windows:
/// no path separators, reserved characters or control characters, no
/// leading dots, and not too long. "Untitled" when nothing is left.
pub fn file_stem(title: &str) -> String {
    let cleaned: String =
        title.chars().map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { ' ' } else { c }).collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_matches(|c: char| c == '.' || c == ' ');
    let mut stem: String = trimmed.chars().take(MAX_STEM).collect();
    stem = stem.trim_end_matches(['.', ' ']).to_string();
    let reserved = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "LPT1", "LPT2", "LPT3"];
    if reserved.contains(&stem.to_uppercase().as_str()) {
        stem.push('_');
    }
    if stem.is_empty() || title == EMPTY_TITLE { "Untitled".to_string() } else { stem }
}

fn folder(state: DraftState) -> &'static str {
    match state {
        DraftState::Inbox => "Inbox",
        DraftState::Archived => "Archive",
        DraftState::Trashed => "Trash",
    }
}

/// The files of an export: each draft's markdown, newest first so a name
/// clash renames the older draft ("Title 2.md"), the images they use, and
/// the manifest.
pub fn entries(drafts: &[(DraftSummary, String)], store: &Attachments, now: i64, by: &str) -> Vec<Entry> {
    let mut sorted: Vec<&(DraftSummary, String)> = drafts.iter().collect();
    sorted.sort_by(|a, b| b.0.modified_at.cmp(&a.0.modified_at).then_with(|| b.0.id.cmp(&a.0.id)));
    // Lowercased, since macOS and Windows file systems ignore case.
    let mut taken = HashSet::new();
    let mut files = Vec::new();
    let mut manifest = Vec::new();
    let mut used = BTreeSet::new();
    for (summary, body) in sorted {
        let dir = folder(summary.state);
        let stem = file_stem(&summary.title);
        let mut path = format!("{dir}/{stem}.md");
        let mut n = 2;
        while !taken.insert(path.to_lowercase()) {
            path = format!("{dir}/{stem} {n}.md");
            n += 1;
        }
        let mut record = json!({
            "id": summary.id,
            "title": summary.title,
            "state": summary.state,
            "file": path,
            "created": iso8601(summary.created_at),
            "modified": iso8601(summary.modified_at),
        });
        if let Some(t) = summary.trashed_at {
            record["trashed"] = json!(iso8601(t));
        }
        let images: BTreeSet<&str> = attachments::references(body).collect();
        if !images.is_empty() {
            record["attachments"] = json!(images);
        }
        used.extend(images);
        manifest.push(record);
        let text = attachments::replace_references(body, |name| format!("../attachments/{name}"));
        files.push(Entry { path, contents: Contents::Bytes(text.into_bytes()), modified: summary.modified_at });
    }
    files.extend(attachment_entries(used, store, now));
    let manifest = json!({ "exported": iso8601(now), "by": by, "drafts": manifest });
    files.push(Entry {
        path: "drafts.json".into(),
        contents: Contents::Bytes(serde_json::to_vec_pretty(&manifest).expect("json")),
        modified: now,
    });
    files
}

/// One draft on its own: its markdown, named from its title, and the
/// images it uses in `attachments/` beside it.
pub fn draft_entries(summary: &DraftSummary, body: &str, store: &Attachments, now: i64) -> Vec<Entry> {
    let text = attachments::replace_references(body, |name| format!("attachments/{name}"));
    let mut files = vec![Entry {
        path: format!("{}.md", file_stem(&summary.title)),
        contents: Contents::Bytes(text.into_bytes()),
        modified: summary.modified_at,
    }];
    files.extend(attachment_entries(attachments::references(body).collect(), store, now));
    files
}

/// The attachments in `names` that are here, under `attachments/`, each
/// dated from when it was added.
fn attachment_entries(names: BTreeSet<&str>, store: &Attachments, now: i64) -> Vec<Entry> {
    names
        .into_iter()
        .filter_map(|name| {
            let path = store.path(name)?;
            let modified = std::fs::metadata(&path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map_or(now, |d| d.as_millis() as i64);
            Some(Entry { path: format!("attachments/{name}"), contents: Contents::File(path), modified })
        })
        .collect()
}

fn system_time(ms: i64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_millis(ms.max(0) as u64)
}

/// Writes the entries into `dir`, which has to be new or empty so nothing
/// already there is overwritten.
pub fn write_dir(entries: &[Entry], dir: &Path) -> Result<()> {
    if dir.exists() && std::fs::read_dir(dir)?.next().is_some() {
        bail!("{} isn't empty; export into a new or empty folder", dir.display());
    }
    for entry in entries {
        let path = dir.join(&entry.path);
        std::fs::create_dir_all(path.parent().expect("entries have a parent"))?;
        let mut file = File::create(&path).with_context(|| format!("writing {}", path.display()))?;
        match &entry.contents {
            Contents::Bytes(bytes) => file.write_all(bytes)?,
            Contents::File(from) => {
                std::io::copy(
                    &mut File::open(from).with_context(|| format!("reading {}", from.display()))?,
                    &mut file,
                )?;
            }
        }
        file.set_modified(system_time(entry.modified))?;
    }
    Ok(())
}

/// Writes the entries into a zip at `path`, replacing it only when
/// `overwrite` is set. The zip is written beside it first and moved into
/// place, so a failure never leaves half a file.
pub fn write_zip(entries: &[Entry], path: &Path, overwrite: bool) -> Result<()> {
    use zip::write::SimpleFileOptions;
    if path.exists() && !overwrite {
        bail!("{} already exists", path.display());
    }
    let partial = path.with_extension("zip.partial");
    let mut zip =
        zip::ZipWriter::new(File::create(&partial).with_context(|| format!("writing {}", partial.display()))?);
    for entry in entries {
        let c = civil(entry.modified);
        let when = zip::DateTime::from_date_and_time(c.year as u16, c.month, c.day, c.hour, c.minute, c.second)
            .unwrap_or_default();
        // Images are compressed already.
        let method = match entry.contents {
            Contents::Bytes(_) => zip::CompressionMethod::Deflated,
            Contents::File(_) => zip::CompressionMethod::Stored,
        };
        let options = SimpleFileOptions::default().compression_method(method).last_modified_time(when);
        zip.start_file(entry.path.as_str(), options)?;
        match &entry.contents {
            Contents::Bytes(bytes) => zip.write_all(bytes)?,
            Contents::File(from) => {
                std::io::copy(&mut File::open(from).with_context(|| format!("reading {}", from.display()))?, &mut zip)?;
            }
        }
    }
    zip.finish()?;
    std::fs::rename(&partial, path).with_context(|| format!("moving the export to {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attachments::PIXEL;
    use std::io::Read;

    fn bytes(entry: &Entry) -> Vec<u8> {
        match &entry.contents {
            Contents::Bytes(b) => b.clone(),
            Contents::File(p) => std::fs::read(p).unwrap(),
        }
    }

    fn no_attachments() -> Attachments {
        Attachments::new(PathBuf::from("/nonexistent/attachments"))
    }

    fn draft(id: &str, title: &str, state: DraftState, modified: i64) -> (DraftSummary, String) {
        let summary = DraftSummary {
            id: id.into(),
            title: title.into(),
            state,
            created_at: 1_000,
            modified_at: modified,
            trashed_at: (state == DraftState::Trashed).then_some(modified),
            preview: String::new(),
            snippet: None,
        };
        (summary, format!("# {title}\n\nbody of {id}\n"))
    }

    #[test]
    fn titles_become_safe_file_names() {
        assert_eq!(file_stem("Q4 planning notes"), "Q4 planning notes");
        assert_eq!(file_stem("a/b: c? \"d\" <e>|f*"), "a b c d e f");
        assert_eq!(file_stem("...hidden"), "hidden");
        assert_eq!(file_stem("   "), "Untitled");
        assert_eq!(file_stem(EMPTY_TITLE), "Untitled");
        assert_eq!(file_stem("con"), "con_");
        assert_eq!(file_stem(&"word ".repeat(40)).chars().count(), 79);
    }

    #[test]
    fn drafts_go_in_folders_by_place_with_clashes_numbered() {
        let drafts = [
            draft("A", "Ideas", DraftState::Inbox, 300),
            draft("B", "ideas", DraftState::Inbox, 200),
            draft("C", "Ideas", DraftState::Archived, 100),
            draft("D", "Old", DraftState::Trashed, 50),
        ];
        let files = entries(&drafts, &no_attachments(), 400, "test");
        let paths: Vec<&str> = files.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, ["Inbox/Ideas.md", "Inbox/ideas 2.md", "Archive/Ideas.md", "Trash/Old.md", "drafts.json"]);
        assert_eq!(bytes(&files[0]), b"# Ideas\n\nbody of A\n");
        let manifest: serde_json::Value = serde_json::from_slice(&bytes(&files[4])).unwrap();
        assert_eq!(manifest["drafts"][1]["id"], "B");
        assert_eq!(manifest["drafts"][1]["file"], "Inbox/ideas 2.md");
        assert_eq!(manifest["drafts"][3]["state"], "trashed");
        assert!(manifest["drafts"][3]["trashed"].is_string());
    }

    #[test]
    fn a_folder_export_keeps_dates_and_refuses_to_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("export");
        let files = entries(
            &[draft("A", "Ideas", DraftState::Inbox, 1_790_000_000_000)],
            &no_attachments(),
            1_790_000_000_000,
            "test",
        );
        write_dir(&files, &out).unwrap();
        let path = out.join("Inbox/Ideas.md");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# Ideas\n\nbody of A\n");
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), system_time(1_790_000_000_000));
        assert!(write_dir(&files, &out).is_err(), "not into a folder that has things in it");
    }

    #[test]
    fn a_zip_export_holds_the_same_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("export.zip");
        let files = entries(
            &[draft("A", "Ideas", DraftState::Inbox, 1_790_000_000_000)],
            &no_attachments(),
            1_790_000_000_000,
            "test",
        );
        write_zip(&files, &path, false).unwrap();
        let mut zip = zip::ZipArchive::new(File::open(&path).unwrap()).unwrap();
        let mut text = String::new();
        zip.by_name("Inbox/Ideas.md").unwrap().read_to_string(&mut text).unwrap();
        assert_eq!(text, "# Ideas\n\nbody of A\n");
        assert!(zip.by_name("drafts.json").is_ok());
        assert!(write_zip(&files, &path, false).is_err(), "not over an existing file unless asked");
        write_zip(&files, &path, true).unwrap();
        assert!(!dir.path().join("export.zip.partial").exists());
    }

    #[test]
    fn images_go_in_an_attachments_folder() {
        let dir = tempfile::tempdir().unwrap();
        let store = Attachments::new(dir.path().join("attachments"));
        let name = store.add(PIXEL).unwrap();
        let missing = "0123456789abcdef0123456789abcdef.png";
        let (mut summary, _) = draft("A", "Shots", DraftState::Inbox, 300);
        let body = format!("# Shots\n\n![](attachment:{name})\n![](attachment:{missing})\n");
        summary.title = "Shots".into();
        let drafts = [(summary.clone(), body.clone()), draft("B", "Plain", DraftState::Archived, 200)];

        let files = entries(&drafts, &store, 400, "test");
        let paths: Vec<&str> = files.iter().map(|e| e.path.as_str()).collect();
        let attachment = format!("attachments/{name}");
        assert_eq!(paths, ["Inbox/Shots.md", "Archive/Plain.md", attachment.as_str(), "drafts.json"]);
        let text = String::from_utf8(bytes(&files[0])).unwrap();
        assert!(text.contains(&format!("![](../attachments/{name})")), "{text}");
        assert_eq!(bytes(&files[2]), PIXEL);
        let manifest: serde_json::Value = serde_json::from_slice(&bytes(&files[3])).unwrap();
        assert_eq!(manifest["drafts"][0]["attachments"], json!([missing, name]));
        assert!(manifest["drafts"][1].get("attachments").is_none());

        let zip_path = dir.path().join("export.zip");
        write_zip(&files, &zip_path, false).unwrap();
        let mut zip = zip::ZipArchive::new(File::open(&zip_path).unwrap()).unwrap();
        let mut image = Vec::new();
        zip.by_name(&attachment).unwrap().read_to_end(&mut image).unwrap();
        assert_eq!(image, PIXEL);

        let one = draft_entries(&summary, &body, &store, 400);
        let paths: Vec<&str> = one.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, ["Shots.md", attachment.as_str()]);
        assert!(String::from_utf8(bytes(&one[0])).unwrap().contains(&format!("![](attachments/{name})")));
        let out = dir.path().join("one");
        write_dir(&one, &out).unwrap();
        assert_eq!(std::fs::read(out.join(&attachment)).unwrap(), PIXEL);
    }
}
