#![allow(dead_code)] // each test binary compiles this and uses a subset

//! A minimal HTTP/1.1 server for the integration tests.
//!
//! Exists so the connector's real `discover` path -- request construction, the
//! `Authorization` header, status handling, redirect refusal -- is executed,
//! rather than only its parsing functions. A hand-rolled server keeps the test
//! dependency surface at zero.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;

/// What the server should answer for a given path.
#[derive(Clone)]
pub struct Route {
    pub status: u16,
    pub body: String,
    /// Extra headers, e.g. a `Location` for a redirect.
    pub headers: Vec<(String, String)>,
}

impl Route {
    pub fn ok(body: &str) -> Self {
        Route {
            status: 200,
            body: body.to_string(),
            headers: Vec::new(),
        }
    }

    pub fn status(status: u16) -> Self {
        Route {
            status,
            body: String::new(),
            headers: Vec::new(),
        }
    }

    pub fn redirect(location: &str) -> Self {
        Route {
            status: 302,
            body: String::new(),
            headers: vec![("Location".to_string(), location.to_string())],
        }
    }
}

/// One request the server saw, so the test can assert on what was sent.
#[derive(Debug, Clone)]
pub struct SeenRequest {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
}

impl SeenRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// A running test server. Shuts down when dropped.
pub struct TestServer {
    pub base: String,
    seen: Arc<Mutex<Vec<SeenRequest>>>,
    shutdown: Option<mpsc::Sender<()>>,
    handle: Option<thread::JoinHandle<()>>,
}

impl TestServer {
    /// Start a server that answers `routes`, matched on exact path.
    ///
    /// An unmatched path answers 404, which makes a typo in a test obvious
    /// rather than silently passing.
    pub fn start(routes: Vec<(&'static str, Route)>) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().expect("addr").port();
        listener
            .set_nonblocking(true)
            .expect("non-blocking listener");

        let seen: Arc<Mutex<Vec<SeenRequest>>> = Arc::new(Mutex::new(Vec::new()));
        let seen_for_thread = Arc::clone(&seen);
        let (tx, rx): (mpsc::Sender<()>, Receiver<()>) = mpsc::channel();

        let handle = thread::spawn(move || {
            let routes = routes;
            loop {
                if rx.try_recv().is_ok() {
                    return;
                }
                match listener.accept() {
                    Ok((stream, _)) => {
                        serve_one(stream, &routes, &seen_for_thread);
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(std::time::Duration::from_millis(5));
                    }
                    Err(_) => return,
                }
            }
        });

        TestServer {
            base: format!("http://127.0.0.1:{port}"),
            seen,
            shutdown: Some(tx),
            handle: Some(handle),
        }
    }

    /// Every request the server handled, in order.
    pub fn requests(&self) -> Vec<SeenRequest> {
        self.seen.lock().expect("seen lock").clone()
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn serve_one(mut stream: TcpStream, routes: &[(&str, Route)], seen: &Arc<Mutex<Vec<SeenRequest>>>) {
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .ok();
    let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() || request_line.trim().is_empty() {
        return;
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();

    let mut headers = Vec::new();
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            break;
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            let name = name.trim().to_string();
            let value = value.trim().to_string();
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.parse().unwrap_or(0);
            }
            headers.push((name, value));
        }
    }
    if content_length > 0 {
        let mut body = vec![0u8; content_length];
        let _ = reader.read_exact(&mut body);
    }

    seen.lock().expect("seen lock").push(SeenRequest {
        method,
        path: path.clone(),
        headers,
    });

    let route = routes
        .iter()
        .find(|(p, _)| *p == path)
        .map(|(_, r)| r.clone())
        .unwrap_or_else(|| Route {
            status: 404,
            body: "{}".to_string(),
            headers: Vec::new(),
        });

    let reason = match route.status {
        200 => "OK",
        302 => "Found",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        _ => "Status",
    };

    let mut response = format!("HTTP/1.1 {} {reason}\r\n", route.status);
    response.push_str("Content-Type: application/json\r\n");
    response.push_str(&format!("Content-Length: {}\r\n", route.body.len()));
    response.push_str("Connection: close\r\n");
    for (name, value) in &route.headers {
        response.push_str(&format!("{name}: {value}\r\n"));
    }
    response.push_str("\r\n");
    response.push_str(&route.body);

    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}
