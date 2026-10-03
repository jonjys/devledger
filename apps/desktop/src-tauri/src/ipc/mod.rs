//! The commands the frontend can call, one module per area. Their names are
//! the IPC contract and are registered in `run`.

pub mod connectors;
pub mod lifecycle;
pub mod manual;
pub mod paste;
pub mod secrets;
pub mod vault;
