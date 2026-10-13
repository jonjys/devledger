//! The user's own layout: which boxes the home page shows, in what order, the
//! tab order, and their saved templates.
//!
//! It is the interface's document, stored as JSON in the vault's settings
//! table. The core only bounds its size and checks it is JSON; what the boxes
//! mean is the frontend's business. It lives in the vault (encrypted with
//! everything else) because notes typed into a box may say more than they
//! should.

use super::*;

const LAYOUT_SETTING: &str = "ui.layout";

/// The largest layout accepted: generous for a few dozen boxes and notes.
pub const MAX_LAYOUT_BYTES: usize = 256 * 1024;

impl Vault {
    /// The saved layout, or `None` when the user has never changed it.
    pub fn ui_layout(&self) -> Result<Option<String>> {
        match self.store()?.setting(LAYOUT_SETTING)? {
            None => Ok(None),
            Some(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| CoreError::Invalid("the saved layout is not text".into())),
        }
    }

    /// Replace the saved layout. Not audited: it is presentation, not ledger data.
    pub fn set_ui_layout(&self, json: &str) -> Result<()> {
        if json.len() > MAX_LAYOUT_BYTES {
            return Err(CoreError::Invalid(format!(
                "the layout is too large (over {} KB)",
                MAX_LAYOUT_BYTES / 1024
            )));
        }
        if serde_json::from_str::<serde_json::Value>(json)
            .map(|v| !v.is_object())
            .unwrap_or(true)
        {
            return Err(CoreError::Invalid(
                "the layout must be a JSON object".into(),
            ));
        }
        self.store()?.set_setting(LAYOUT_SETTING, json.as_bytes())
    }

    /// Forget the saved layout, so the recommended one shows again.
    pub fn reset_ui_layout(&self) -> Result<()> {
        self.store()?.delete_setting(LAYOUT_SETTING).map(|_| ())
    }
}
