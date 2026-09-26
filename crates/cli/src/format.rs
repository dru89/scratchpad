//! Text output for the CLI and MCP tools.

use scratchpad_core::protocol::{DraftState, DraftSummary};

/// Enough of a ULID to be unique in practice: the 10-character timestamp
/// plus two random characters. Any unique prefix resolves.
pub fn short_id(id: &str) -> &str {
    &id[..id.len().min(12)]
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

/// "now", "5m", "3h", "12d", "4mo", "2y".
pub fn relative(ms: i64, now: i64) -> String {
    let secs = (now - ms).max(0) / 1000;
    match secs {
        s if s < 60 => "now".into(),
        s if s < 3600 => format!("{}m", s / 60),
        s if s < 86_400 => format!("{}h", s / 3600),
        s if s < 60 * 86_400 => format!("{}d", s / 86_400),
        s if s < 730 * 86_400 => format!("{}mo", s / (30 * 86_400)),
        s => format!("{}y", s / (365 * 86_400)),
    }
}

/// UTC timestamp like 2026-09-26T14:03:09Z.
pub fn iso8601(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn state_label(state: DraftState) -> &'static str {
    match state {
        DraftState::Inbox => "inbox",
        DraftState::Archived => "archive",
        DraftState::Trashed => "trash",
    }
}

/// One line per draft; the state column only when more than one state is shown.
pub fn draft_lines(drafts: &[DraftSummary], show_state: bool) -> String {
    let now = now_ms();
    let mut out = String::new();
    for d in drafts {
        let when = relative(d.modified_at, now);
        if show_state {
            out.push_str(&format!("{}  {:>4}  {:<7}  {}\n", short_id(&d.id), when, state_label(d.state), d.title));
        } else {
            out.push_str(&format!("{}  {:>4}  {}\n", short_id(&d.id), when, d.title));
        }
        if let Some(snippet) = &d.snippet {
            out.push_str(&format!("{}  {}\n", " ".repeat(12 + 6), snippet));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso8601_matches_known_dates() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(951_782_400_000), "2000-02-29T00:00:00Z");
        assert_eq!(iso8601(1_790_424_189_000), "2026-09-26T12:03:09Z");
    }

    #[test]
    fn relative_times() {
        let now = 10_000_000_000;
        assert_eq!(relative(now - 30_000, now), "now");
        assert_eq!(relative(now - 5 * 60_000, now), "5m");
        assert_eq!(relative(now - 3 * 3_600_000, now), "3h");
        assert_eq!(relative(now - 12 * 86_400_000, now), "12d");
        assert_eq!(relative(now + 5_000, now), "now");
    }
}
