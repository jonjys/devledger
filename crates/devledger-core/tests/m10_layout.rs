//! The interface layout: kept in the vault, bounded, and never mistaken for ledger data.

mod common;

use devledger_core::CoreError;

#[test]
fn a_layout_is_saved_replaced_and_reset() {
    let (_dir, vault) = common::unlocked_vault();
    assert_eq!(vault.ui_layout().unwrap(), None);

    vault
        .set_ui_layout(r#"{"v":1,"boxes":[{"id":"a","kind":"note","text":"call the bank"}]}"#)
        .expect("save");
    assert!(vault
        .ui_layout()
        .unwrap()
        .unwrap()
        .contains("call the bank"));

    vault
        .set_ui_layout(r#"{"v":1,"boxes":[]}"#)
        .expect("replace");
    assert_eq!(
        vault.ui_layout().unwrap().as_deref(),
        Some(r#"{"v":1,"boxes":[]}"#)
    );

    vault.reset_ui_layout().expect("reset");
    assert_eq!(vault.ui_layout().unwrap(), None);
}

#[test]
fn only_a_bounded_json_object_is_accepted() {
    let (_dir, vault) = common::unlocked_vault();
    for bad in ["", "not json", "[1,2]", "\"text\""] {
        assert!(
            matches!(vault.set_ui_layout(bad), Err(CoreError::Invalid(_))),
            "accepted {bad:?}"
        );
    }
    let huge = format!(r#"{{"text":"{}"}}"#, "x".repeat(300 * 1024));
    assert!(matches!(
        vault.set_ui_layout(&huge),
        Err(CoreError::Invalid(_))
    ));
}

#[test]
fn the_layout_is_not_written_to_the_audit_log() {
    let (_dir, vault) = common::unlocked_vault();
    let before = vault.recent_audit(50).unwrap().len();
    vault.set_ui_layout(r#"{"v":1}"#).unwrap();
    assert_eq!(vault.recent_audit(50).unwrap().len(), before);
}
