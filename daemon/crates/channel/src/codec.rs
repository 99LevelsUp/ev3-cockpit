//! JSON-RPC 2.0 messages framed the way `vscode-jsonrpc` and LSP frame them: a header block of
//! `Name: value` lines, one of them `Content-Length`, an empty line, then that many bytes of JSON.
//!
//! A message whose declared length is over 1 MiB, or a header block over 8 KiB, is an error before
//! its body is read; the connection closes on it, so a broken or hostile peer cannot make the
//! daemon buffer without limit.

use bytes::{Buf, BufMut, BytesMut};
use serde_json::Value;
use tokio_util::codec::{Decoder, Encoder};

/// The largest message body, in bytes.
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
/// The largest header block, in bytes.
pub const MAX_HEADER_BYTES: usize = 8 * 1024;

/// Why a stream of messages cannot be read on.
#[derive(Debug)]
pub enum CodecError {
    /// A declared length over the cap.
    Oversize(usize),
    /// A header block over the cap.
    HeaderTooLong,
    /// A header block without a usable `Content-Length`.
    NoLength,
    /// A body that is not JSON.
    BadJson(serde_json::Error),
    /// The stream failed.
    Io(std::io::Error),
}

impl std::fmt::Display for CodecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Oversize(bytes) => write!(
                f,
                "a message of {bytes} bytes is over the {MAX_MESSAGE_BYTES}-byte limit"
            ),
            Self::HeaderTooLong => f.write_str("a message header was too long"),
            Self::NoLength => f.write_str("a message had no Content-Length"),
            Self::BadJson(error) => write!(f, "a message was not JSON ({error})"),
            Self::Io(error) => write!(f, "the stream failed ({error})"),
        }
    }
}

impl std::error::Error for CodecError {}

impl From<std::io::Error> for CodecError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

/// The framing, for `FramedRead` and `FramedWrite`.
#[derive(Debug, Default)]
pub struct JsonRpcCodec {
    body: Option<usize>,
}

fn content_length(header: &[u8]) -> Result<usize, CodecError> {
    let text = std::str::from_utf8(header).map_err(|_| CodecError::NoLength)?;
    for line in text.split("\r\n") {
        if let Some((name, value)) = line.split_once(':')
            && name.trim().eq_ignore_ascii_case("content-length")
        {
            let length: usize = value.trim().parse().map_err(|_| CodecError::NoLength)?;
            if length > MAX_MESSAGE_BYTES {
                return Err(CodecError::Oversize(length));
            }
            return Ok(length);
        }
    }
    Err(CodecError::NoLength)
}

impl Decoder for JsonRpcCodec {
    type Item = Value;
    type Error = CodecError;

    fn decode(&mut self, src: &mut BytesMut) -> Result<Option<Value>, CodecError> {
        let length = match self.body {
            Some(length) => length,
            None => {
                let window = &src[..src.len().min(MAX_HEADER_BYTES + 4)];
                let Some(end) = window.windows(4).position(|w| w == b"\r\n\r\n") else {
                    if src.len() > MAX_HEADER_BYTES {
                        return Err(CodecError::HeaderTooLong);
                    }
                    return Ok(None);
                };
                let length = content_length(&src[..end])?;
                src.advance(end + 4);
                self.body = Some(length);
                length
            }
        };
        if src.len() < length {
            src.reserve(length - src.len());
            return Ok(None);
        }
        let body = src.split_to(length);
        self.body = None;
        serde_json::from_slice(&body)
            .map(Some)
            .map_err(CodecError::BadJson)
    }
}

impl Encoder<Value> for JsonRpcCodec {
    type Error = CodecError;

    fn encode(&mut self, item: Value, dst: &mut BytesMut) -> Result<(), CodecError> {
        let body = serde_json::to_vec(&item).map_err(CodecError::BadJson)?;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        dst.reserve(header.len() + body.len());
        dst.put_slice(header.as_bytes());
        dst.put_slice(&body);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn frame(body: &str) -> BytesMut {
        BytesMut::from(format!("Content-Length: {}\r\n\r\n{body}", body.len()).as_bytes())
    }

    #[test]
    fn a_framed_message_round_trips() {
        let mut codec = JsonRpcCodec::default();
        let mut buffer = BytesMut::new();
        let message = json!({"jsonrpc": "2.0", "id": 1, "method": "daemon/status"});
        codec.encode(message.clone(), &mut buffer).expect("encode");
        assert_eq!(codec.decode(&mut buffer).expect("decode"), Some(message));
        assert!(buffer.is_empty());
    }

    #[test]
    fn a_message_arriving_in_pieces_is_read_once_whole() {
        let mut codec = JsonRpcCodec::default();
        let whole = frame(r#"{"a":1}"#);
        let mut buffer = BytesMut::new();
        for byte in whole.iter() {
            assert_eq!(codec.decode(&mut buffer).expect("partial"), None);
            buffer.put_u8(*byte);
        }
        assert_eq!(
            codec.decode(&mut buffer).expect("whole"),
            Some(json!({"a": 1}))
        );
    }

    #[test]
    fn other_headers_and_any_case_are_accepted() {
        let mut codec = JsonRpcCodec::default();
        let mut buffer = BytesMut::from(
            &b"content-type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: 2\r\n\r\n{}"[..],
        );
        assert_eq!(codec.decode(&mut buffer).expect("decode"), Some(json!({})));
    }

    #[test]
    fn a_declared_length_over_the_cap_fails_before_the_body() {
        let mut codec = JsonRpcCodec::default();
        let mut buffer =
            BytesMut::from(format!("Content-Length: {}\r\n\r\n", MAX_MESSAGE_BYTES + 1).as_bytes());
        assert!(matches!(
            codec.decode(&mut buffer),
            Err(CodecError::Oversize(n)) if n == MAX_MESSAGE_BYTES + 1
        ));
        let mut codec = JsonRpcCodec::default();
        let mut exact = frame(&format!("\"{}\"", "x".repeat(MAX_MESSAGE_BYTES - 2)));
        assert!(codec.decode(&mut exact).expect("at the cap").is_some());
    }

    #[test]
    fn a_header_that_never_ends_fails() {
        let mut codec = JsonRpcCodec::default();
        let mut buffer = BytesMut::from(vec![b'x'; MAX_HEADER_BYTES + 1].as_slice());
        assert!(matches!(
            codec.decode(&mut buffer),
            Err(CodecError::HeaderTooLong)
        ));
    }

    #[test]
    fn a_header_without_a_length_or_a_body_that_is_not_json_fails() {
        let mut codec = JsonRpcCodec::default();
        let mut buffer = BytesMut::from(&b"X-Other: 1\r\n\r\n{}"[..]);
        assert!(matches!(
            codec.decode(&mut buffer),
            Err(CodecError::NoLength)
        ));
        let mut codec = JsonRpcCodec::default();
        let mut buffer = frame("{nope");
        assert!(matches!(
            codec.decode(&mut buffer),
            Err(CodecError::BadJson(_))
        ));
    }
}
