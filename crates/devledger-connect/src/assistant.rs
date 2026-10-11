//! The AI assistant's transport: Anthropic's Messages API.
//!
//! This is the one place in DevLedger that sends a `POST`. Everything else in
//! this crate reads from a provider; the assistant has to send a question to
//! get an answer. The guard rails are the same as for the connectors:
//!
//! - Requests are built only from [`API_BASE`] and checked against
//!   [`ALLOWED_HOSTS`] before anything is sent.
//! - Redirects are refused, so the API key cannot follow one off-host.
//! - What is sent is the outline `devledger_core::assistant` built: names and
//!   relationships, no secret values, no previews, no email addresses. This
//!   module adds nothing to it but the model settings.
//! - A request only happens because the user pressed a button.
//!
//! There is no official Rust SDK for the Claude API, so this speaks the
//! documented HTTP shape directly.

use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

use crate::{check_host, ConnectError, USER_AGENT};

/// The API base. Requests are built only from this constant.
pub const API_BASE: &str = "https://api.anthropic.com";

/// The only host the assistant may contact.
pub const ALLOWED_HOSTS: &[&str] = &["api.anthropic.com"];

/// The model the assistant asks.
pub const MODEL: &str = "claude-opus-5-5";

/// The API version header the request shape follows.
pub const API_VERSION: &str = "2023-06-01";

/// Server-side fallback: if the model declines, the API retries on the model
/// Anthropic recommends for that case instead of returning the refusal.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

/// Room for the model's thinking as well as its answer.
const MAX_TOKENS: u32 = 16_000;

/// An answer can take a while: the model thinks before it writes.
const TIMEOUT: Duration = Duration::from_secs(180);

/// What came back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer {
    /// The answer as Markdown, with any placeholders still in it.
    pub text: String,
    /// The model that actually answered (a fallback may have stepped in).
    pub model: String,
    /// Tokens sent.
    pub input_tokens: u64,
    /// Tokens received, thinking included.
    pub output_tokens: u64,
    /// Whether the answer was cut off at the length limit.
    pub truncated: bool,
}

fn client() -> Result<reqwest::Client, ConnectError> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| ConnectError::Network(e.to_string()))
}

#[derive(Deserialize)]
struct ApiError {
    error: ApiErrorBody,
}

#[derive(Deserialize)]
struct ApiErrorBody {
    #[serde(default)]
    message: String,
}

/// Turn a failed response into something a user can act on.
fn failure(status: u16, body: &str) -> ConnectError {
    let message = serde_json::from_str::<ApiError>(body)
        .map(|e| e.error.message)
        .unwrap_or_default();
    match status {
        401 => ConnectError::Unauthorized,
        403 => ConnectError::Forbidden("the Claude API".into()),
        429 => ConnectError::RateLimited,
        529 => ConnectError::Unexpected(
            "Anthropic is overloaded right now. Try again in a minute.".into(),
        ),
        _ if !message.is_empty() => ConnectError::Unexpected(message),
        other => ConnectError::Unexpected(format!("HTTP {other} from the Claude API")),
    }
}

/// Check that an API key works, with one read of the model list.
pub async fn verify(api_key: &str) -> Result<(), ConnectError> {
    let url = format!("{API_BASE}/v1/models?limit=1");
    check_host(&url, ALLOWED_HOSTS)?;
    let response = client()?
        .get(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", API_VERSION)
        .send()
        .await
        .map_err(|e| ConnectError::Network(e.without_url().to_string()))?;
    let status = response.status().as_u16();
    if status == 200 {
        return Ok(());
    }
    let body = response.text().await.unwrap_or_default();
    Err(failure(status, &body))
}

/// The request body. Pure, so the tests can check exactly what is sent.
pub fn request_body(system: &str, user: &str) -> serde_json::Value {
    json!({
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "fallbacks": "default",
        "output_config": { "effort": "medium" },
        "system": system,
        "messages": [{ "role": "user", "content": user }],
    })
}

/// Send one question and wait for the answer.
pub async fn ask(api_key: &str, system: &str, user: &str) -> Result<Answer, ConnectError> {
    let url = format!("{API_BASE}/v1/messages");
    check_host(&url, ALLOWED_HOSTS)?;
    let response = client()?
        .post(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", API_VERSION)
        .header("anthropic-beta", FALLBACK_BETA)
        .json(&request_body(system, user))
        .send()
        .await
        .map_err(|e| ConnectError::Network(e.without_url().to_string()))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|e| ConnectError::Network(e.without_url().to_string()))?;
    if status != 200 {
        return Err(failure(status, &body));
    }
    parse_answer(&body)
}

#[derive(Deserialize)]
struct ApiMessage {
    #[serde(default)]
    model: String,
    #[serde(default)]
    content: Vec<ApiBlock>,
    #[serde(default)]
    stop_reason: Option<String>,
    #[serde(default)]
    usage: Option<ApiUsage>,
}

#[derive(Deserialize)]
struct ApiBlock {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: Option<String>,
}

#[derive(Deserialize)]
struct ApiUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
}

/// Read a Messages API response. Only `text` blocks are the answer: thinking
/// and fallback markers are skipped.
pub fn parse_answer(body: &str) -> Result<Answer, ConnectError> {
    let message: ApiMessage =
        serde_json::from_str(body).map_err(|e| ConnectError::Malformed(e.to_string()))?;
    // A refusal is a normal 200 response; its content must not be read as an answer.
    if message.stop_reason.as_deref() == Some("refusal") {
        return Err(ConnectError::Declined(
            "the assistant declined to answer this one. Try asking it differently.".into(),
        ));
    }
    let text = message
        .content
        .iter()
        .filter(|b| b.kind == "text")
        .filter_map(|b| b.text.as_deref())
        .collect::<Vec<_>>()
        .join("\n\n");
    if text.trim().is_empty() {
        return Err(ConnectError::Malformed("the answer was empty".into()));
    }
    let usage = message.usage.unwrap_or(ApiUsage {
        input_tokens: 0,
        output_tokens: 0,
    });
    Ok(Answer {
        text,
        model: message.model,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        truncated: message.stop_reason.as_deref() == Some("max_tokens"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_holds_the_outline_and_the_model_settings_only() {
        let body = request_body("instructions", "outline");
        assert_eq!(body["model"], MODEL);
        assert_eq!(body["fallbacks"], "default");
        assert_eq!(body["system"], "instructions");
        assert_eq!(body["messages"][0]["content"], "outline");
        assert!(
            body.get("thinking").is_none(),
            "thinking is always on for this model"
        );
        assert_eq!(body.as_object().unwrap().len(), 6);
    }

    #[test]
    fn only_text_blocks_are_the_answer() {
        let body = r#"{
            "model": "claude-opus-5-5",
            "content": [
                {"type": "thinking", "thinking": ""},
                {"type": "text", "text": "Do this first: roll the key"}
            ],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 1200, "output_tokens": 300}
        }"#;
        let a = parse_answer(body).unwrap();
        assert_eq!(a.text, "Do this first: roll the key");
        assert_eq!((a.input_tokens, a.output_tokens), (1200, 300));
        assert!(!a.truncated);
    }

    #[test]
    fn a_refusal_is_an_error_not_an_answer() {
        let body = r#"{"model":"claude-opus-5-5","content":[],"stop_reason":"refusal","stop_details":null}"#;
        assert!(matches!(parse_answer(body), Err(ConnectError::Declined(_))));
    }

    #[test]
    fn a_cut_off_answer_says_so() {
        let body = r#"{"model":"m","content":[{"type":"text","text":"partial"}],"stop_reason":"max_tokens"}"#;
        assert!(parse_answer(body).unwrap().truncated);
    }

    #[test]
    fn api_errors_read_as_sentences() {
        let body = r#"{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low."}}"#;
        assert_eq!(
            failure(400, body).to_string(),
            "the provider returned an unexpected response: Your credit balance is too low."
        );
        assert!(matches!(failure(401, ""), ConnectError::Unauthorized));
        assert!(matches!(failure(429, ""), ConnectError::RateLimited));
    }

    #[test]
    fn requests_only_go_to_anthropic() {
        assert!(check_host(&format!("{API_BASE}/v1/messages"), ALLOWED_HOSTS).is_ok());
        assert!(check_host("https://evil.example/v1/messages", ALLOWED_HOSTS).is_err());
        assert!(check_host("http://api.anthropic.com/v1/messages", ALLOWED_HOSTS).is_err());
    }
}
