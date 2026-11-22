//! Questions for a person: the daemon puts them to a VS Code window or a terminal, and only there.
//!
//! A question about an operation a client asked for names that client, by its name and kind. It
//! goes to the requesting client when that client has a person at it (kind `vscode` or `cli`);
//! otherwise to the VS Code window that connected last, else to the terminal that connected last.
//! An MCP server or an add-on is never asked. With nobody to ask, the question ends at once as
//! [`Asked::NoPerson`], and the operation is refused naming the command a person runs.
//!
//! A question nobody answers within [`QUESTION_TIMEOUT`] is withdrawn and counts as unanswered;
//! so does `keep`, an error answer and a connection that closes. Only an explicit yes lets an
//! operation go ahead.
//!
//! A client may ask for its yes or no to be remembered. It is kept per connection and applies to
//! the same question about that client's own later requests only: never to a question another
//! client's request raises, whoever is asked about it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ev3_contract::{ClientKind, QuestionAnswer, QuestionReply, SettingScalar};
use ev3_runtime::Requester;
use serde_json::json;

use crate::state::ClientEntry;

/// How long a person has to answer.
pub const QUESTION_TIMEOUT: Duration = Duration::from_secs(60);

/// Whether a client of `kind` has a person at it who can answer.
pub fn has_person(kind: ClientKind) -> bool {
    matches!(kind, ClientKind::Vscode | ClientKind::Cli)
}

/// What a question is about.
#[derive(Debug, Clone)]
pub enum Topic {
    Forget {
        brick_id: String,
    },
    ClearBluetoothList {
        brick_id: String,
        entries: Vec<String>,
        includes_this_computer: bool,
        this_computer: Option<String>,
    },
    Sweep {
        brick_id: String,
    },
    Setting {
        key: String,
        value: SettingScalar,
    },
    Restart,
}

impl Topic {
    /// What makes two questions the same question, for a remembered answer.
    fn memory_key(&self) -> String {
        match self {
            Self::Forget { brick_id } => format!("forget {brick_id}"),
            Self::ClearBluetoothList { brick_id, .. } => format!("clearBluetoothList {brick_id}"),
            Self::Sweep { brick_id } => format!("sweep {brick_id}"),
            Self::Setting { key, value } => format!(
                "setting {key} {}",
                serde_json::to_string(value).unwrap_or_default()
            ),
            Self::Restart => "restart".into(),
        }
    }

    fn question(
        &self,
        question_id: String,
        text: String,
        timeout_ms: u64,
        requester: ev3_contract::Requester,
    ) -> ev3_contract::Question {
        use ev3_contract::Question as Q;
        match self.clone() {
            Self::Forget { brick_id } => Q::Forget {
                brick_id,
                details: Vec::new(),
                question_id,
                requester,
                text,
                timeout_ms,
            },
            Self::ClearBluetoothList {
                brick_id,
                entries,
                includes_this_computer,
                this_computer,
            } => Q::ClearBluetoothList {
                brick_id,
                details: entries,
                includes_this_computer,
                question_id,
                requester,
                text,
                this_computer,
                timeout_ms,
            },
            Self::Sweep { brick_id } => Q::Sweep {
                brick_id,
                details: Vec::new(),
                question_id,
                requester,
                text,
                timeout_ms,
            },
            Self::Setting { key, value } => Q::Setting {
                details: Vec::new(),
                key,
                question_id,
                requester,
                text,
                timeout_ms,
                value,
            },
            Self::Restart => Q::Restart {
                details: Vec::new(),
                question_id,
                requester,
                text,
                timeout_ms,
            },
        }
    }
}

/// How a question ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Asked {
    Yes,
    No,
    /// Asked, but no yes or no came: `keep`, silence until the timeout, an error answer or a
    /// connection that closed.
    Unanswered,
    /// No VS Code window or terminal was connected to ask.
    NoPerson,
}

impl Asked {
    pub fn granted(self) -> bool {
        self == Self::Yes
    }
}

/// The daemon's questions: where each goes, and the answers clients asked to remember.
pub struct Questions {
    timeout: Duration,
    /// Per connection: remembered answers by question.
    remembered: Mutex<HashMap<u64, HashMap<String, bool>>>,
}

impl Default for Questions {
    fn default() -> Self {
        Self::new(QUESTION_TIMEOUT)
    }
}

impl Questions {
    pub fn new(timeout: Duration) -> Self {
        Self {
            timeout,
            remembered: Mutex::new(HashMap::new()),
        }
    }

    pub fn timeout(&self) -> Duration {
        self.timeout
    }

    /// The client a question for `requester` goes to, among `clients`.
    pub fn target(
        clients: &[Arc<ClientEntry>],
        requester: Option<&Requester>,
    ) -> Option<Arc<ClientEntry>> {
        let open = |c: &&Arc<ClientEntry>| !c.peer.is_closed();
        if let Some(own) = requester
            .and_then(|r| r.connection)
            .and_then(|id| clients.iter().filter(open).find(|c| c.id == id))
            && has_person(own.kind())
        {
            return Some(own.clone());
        }
        let last_of = |kind: ClientKind| {
            clients
                .iter()
                .filter(open)
                .filter(|c| c.kind() == kind)
                .max_by_key(|c| c.id)
                .cloned()
        };
        last_of(ClientKind::Vscode).or_else(|| last_of(ClientKind::Cli))
    }

    /// Whether anybody among `clients` could be asked.
    pub fn can_ask(clients: &[Arc<ClientEntry>]) -> bool {
        Self::target(clients, None).is_some()
    }

    /// Asks a person about `topic` for `requester`, with `text` ready to show.
    pub async fn ask(
        &self,
        clients: &[Arc<ClientEntry>],
        requester: &Requester,
        topic: Topic,
        text: String,
    ) -> Asked {
        let key = topic.memory_key();
        if let Some(remembered) = requester.connection.and_then(|id| {
            self.lock()
                .get(&id)
                .and_then(|answers| answers.get(&key))
                .copied()
        }) {
            return if remembered { Asked::Yes } else { Asked::No };
        }
        let Some(target) = Self::target(clients, Some(requester)) else {
            return Asked::NoPerson;
        };
        let question_id = crate::hex(&crate::random_bytes::<6>());
        let question = topic.question(
            question_id.clone(),
            text,
            u64::try_from(self.timeout.as_millis()).unwrap_or(u64::MAX),
            ev3_contract::Requester {
                name: requester.name.clone(),
                kind: requester.kind,
            },
        );
        let (answer, remember) = self.put(&target, &question_id, &question).await;
        // Kept only for the client's own request: its answer about another client's request
        // never stands in for a later question.
        if remember && answer != Asked::Unanswered && requester.connection == Some(target.id) {
            self.lock()
                .entry(target.id)
                .or_default()
                .insert(key, answer == Asked::Yes);
        }
        answer
    }

    /// Asks a question no client's request raised (the Bluetooth access questions), through the
    /// VS Code window or terminal that connected last.
    pub async fn ask_unrequested(
        &self,
        clients: &[Arc<ClientEntry>],
        question: impl FnOnce(String, u64) -> ev3_contract::Question,
    ) -> Asked {
        let Some(target) = Self::target(clients, None) else {
            return Asked::NoPerson;
        };
        let question_id = crate::hex(&crate::random_bytes::<6>());
        let question = question(
            question_id.clone(),
            u64::try_from(self.timeout.as_millis()).unwrap_or(u64::MAX),
        );
        self.put(&target, &question_id, &question).await.0
    }

    async fn put(
        &self,
        target: &ClientEntry,
        question_id: &str,
        question: &ev3_contract::Question,
    ) -> (Asked, bool) {
        let Ok(params) = serde_json::to_value(question) else {
            return (Asked::Unanswered, false);
        };
        match tokio::time::timeout(self.timeout, target.peer.request("question/ask", params)).await
        {
            Err(_) => {
                target
                    .peer
                    .notify("question/withdrawn", json!({ "questionId": question_id }));
                (Asked::Unanswered, false)
            }
            Ok(Err(_)) => (Asked::Unanswered, false),
            Ok(Ok(value)) => match serde_json::from_value::<QuestionReply>(value) {
                Ok(reply) => {
                    let answer = match reply.answer {
                        QuestionAnswer::Yes => Asked::Yes,
                        QuestionAnswer::No => Asked::No,
                        QuestionAnswer::Keep => Asked::Unanswered,
                    };
                    (answer, reply.remember == Some(true))
                }
                Err(_) => (Asked::Unanswered, false),
            },
        }
    }

    /// A connection closed: its remembered answers go with it.
    pub fn client_left(&self, connection: u64) {
        self.lock().remove(&connection);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u64, HashMap<String, bool>>> {
        self.remembered.lock().expect("questions lock")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ev3_contract::{BuildKind, ClientInfo};
    use serde_json::Value;
    use tokio::sync::mpsc::UnboundedReceiver;

    struct Fake {
        entry: Arc<ClientEntry>,
        out: UnboundedReceiver<Value>,
    }

    fn client(id: u64, name: &str, kind: ClientKind) -> Fake {
        let (peer, out, _closed) = crate::rpc::detached_peer();
        Fake {
            entry: Arc::new(ClientEntry {
                id,
                info: ClientInfo {
                    name: name.into(),
                    kind,
                    version: "0".into(),
                    build_kind: BuildKind::Development,
                },
                contract_version: u64::from(ev3_contract::CONTRACT_VERSION),
                peer,
            }),
            out,
        }
    }

    fn requester(fake: &Fake) -> Requester {
        Requester {
            name: fake.entry.info.name.clone(),
            kind: fake.entry.kind(),
            connection: Some(fake.entry.id),
        }
    }

    fn full() -> Topic {
        Topic::Setting {
            key: "accessMode".into(),
            value: SettingScalar::String("full".into()),
        }
    }

    /// Answers the next question that reaches `fake`, returning it.
    async fn answer(fake: &mut Fake, reply: Value) -> Value {
        let sent = tokio::time::timeout(Duration::from_secs(5), fake.out.recv())
            .await
            .expect("a question reached this client within 5 s")
            .expect("a question went out");
        assert_eq!(sent["method"], "question/ask");
        fake.entry.peer.answer(&sent["id"], reply);
        sent["params"].clone()
    }

    #[tokio::test]
    async fn with_only_an_mcp_client_nobody_is_asked() {
        let questions = Questions::default();
        let mut mcp = client(1, "agent", ClientKind::Mcp);
        let asked = questions
            .ask(
                std::slice::from_ref(&mcp.entry),
                &requester(&mcp),
                full(),
                "Switch to full?".into(),
            )
            .await;
        assert_eq!(asked, Asked::NoPerson);
        assert!(mcp.out.try_recv().is_err(), "the MCP client was not asked");
    }

    #[tokio::test]
    async fn a_question_an_mcp_request_raises_reaches_vscode_naming_the_mcp_client() {
        let questions = Arc::new(Questions::default());
        let mcp = client(1, "claude-agent", ClientKind::Mcp);
        let mut vscode = client(2, "VS Code", ClientKind::Vscode);
        let clients = vec![mcp.entry.clone(), vscode.entry.clone()];
        let who = requester(&mcp);
        let asking = tokio::spawn({
            let questions = questions.clone();
            async move {
                questions
                    .ask(
                        &clients,
                        &who,
                        Topic::Forget {
                            brick_id: "001653F00A0A".into(),
                        },
                        "Forget AAA?".into(),
                    )
                    .await
            }
        });
        let question = answer(&mut vscode, json!({"answer": "yes"})).await;
        assert_eq!(question["kind"], "forget");
        assert_eq!(question["requester"]["name"], "claude-agent");
        assert_eq!(question["requester"]["kind"], "mcp");
        assert_eq!(question["brickId"], "001653F00A0A");
        assert_eq!(question["timeoutMs"], 60_000);
        assert_eq!(asking.await.unwrap(), Asked::Yes);
    }

    #[tokio::test]
    async fn a_remembered_answer_answers_only_its_own_clients_requests() {
        let questions = Arc::new(Questions::default());
        let mut vscode = client(1, "VS Code", ClientKind::Vscode);
        let mcp = client(2, "agent", ClientKind::Mcp);
        let clients = vec![vscode.entry.clone(), mcp.entry.clone()];
        let topic = Topic::Forget {
            brick_id: "001653F00A0A".into(),
        };

        // VS Code's own forget: yes, remembered.
        let own = tokio::spawn({
            let (questions, clients, who, topic) = (
                questions.clone(),
                clients.clone(),
                requester(&vscode),
                topic.clone(),
            );
            async move { questions.ask(&clients, &who, topic, "Forget?".into()).await }
        });
        answer(&mut vscode, json!({"answer": "yes", "remember": true})).await;
        assert_eq!(own.await.unwrap(), Asked::Yes);

        // VS Code again: the remembered yes answers without a question.
        let again = questions
            .ask(
                &clients,
                &requester(&vscode),
                topic.clone(),
                "Forget?".into(),
            )
            .await;
        assert_eq!(again, Asked::Yes);
        assert!(vscode.out.try_recv().is_err(), "nothing was asked");

        // The same question raised by the MCP client's request is put to the person again.
        let other = tokio::spawn({
            let (questions, clients, who, topic) =
                (questions.clone(), clients.clone(), requester(&mcp), topic);
            async move { questions.ask(&clients, &who, topic, "Forget?".into()).await }
        });
        let question = answer(&mut vscode, json!({"answer": "no"})).await;
        assert_eq!(question["requester"]["kind"], "mcp");
        assert_eq!(other.await.unwrap(), Asked::No);
    }

    #[tokio::test]
    async fn an_answer_about_another_clients_request_is_not_remembered() {
        let questions = Arc::new(Questions::default());
        let mut vscode = client(1, "VS Code", ClientKind::Vscode);
        let mcp = client(2, "agent", ClientKind::Mcp);
        let clients = vec![vscode.entry.clone(), mcp.entry.clone()];
        let topic = Topic::Sweep {
            brick_id: "001653F00A0A".into(),
        };
        let first = tokio::spawn({
            let (questions, clients, who, topic) = (
                questions.clone(),
                clients.clone(),
                requester(&mcp),
                topic.clone(),
            );
            async move {
                questions
                    .ask(&clients, &who, topic, "Release?".into())
                    .await
            }
        });
        answer(&mut vscode, json!({"answer": "yes", "remember": true})).await;
        assert_eq!(first.await.unwrap(), Asked::Yes);
        // Neither the MCP client's nor VS Code's next request is answered by it.
        for who in [requester(&mcp), requester(&vscode)] {
            let next = tokio::spawn({
                let (questions, clients, topic) =
                    (questions.clone(), clients.clone(), topic.clone());
                async move {
                    questions
                        .ask(&clients, &who, topic, "Release?".into())
                        .await
                }
            });
            answer(&mut vscode, json!({"answer": "keep"})).await;
            assert_eq!(next.await.unwrap(), Asked::Unanswered);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_question_unanswered_for_60_s_is_withdrawn_and_refused() {
        let questions = Arc::new(Questions::default());
        let mut vscode = client(1, "VS Code", ClientKind::Vscode);
        let clients = vec![vscode.entry.clone()];
        let who = requester(&vscode);
        let asking = tokio::spawn({
            let questions = questions.clone();
            async move { questions.ask(&clients, &who, full(), "Full?".into()).await }
        });
        let sent = vscode.out.recv().await.expect("asked");
        let question_id = sent["params"]["questionId"].clone();
        tokio::time::sleep(Duration::from_secs(59)).await;
        assert!(!asking.is_finished(), "still open after 59 s");
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(asking.await.unwrap(), Asked::Unanswered);
        let withdrawn = vscode.out.recv().await.expect("withdrawn");
        assert_eq!(withdrawn["method"], "question/withdrawn");
        assert_eq!(withdrawn["params"]["questionId"], question_id);
        assert_eq!(vscode.entry.peer.waiting(), 0, "the request was forgotten");
    }

    #[tokio::test]
    async fn the_requester_is_asked_itself_when_it_has_a_person() {
        let questions = Arc::new(Questions::default());
        let mut vscode = client(1, "VS Code", ClientKind::Vscode);
        let mut cli = client(2, "ev3", ClientKind::Cli);
        let clients = vec![vscode.entry.clone(), cli.entry.clone()];
        let who = requester(&cli);
        let asking = tokio::spawn({
            let questions = questions.clone();
            async move { questions.ask(&clients, &who, full(), "Full?".into()).await }
        });
        answer(&mut cli, json!({"answer": "no"})).await;
        assert_eq!(asking.await.unwrap(), Asked::No);
        assert!(vscode.out.try_recv().is_err());
    }

    #[tokio::test]
    async fn an_error_answer_or_a_closed_connection_is_not_a_yes() {
        let questions = Arc::new(Questions::default());
        let mut vscode = client(1, "VS Code", ClientKind::Vscode);
        let clients = vec![vscode.entry.clone()];
        let who = requester(&vscode);
        let asking = tokio::spawn({
            let (questions, clients, who) = (questions.clone(), clients.clone(), who.clone());
            async move { questions.ask(&clients, &who, full(), "Full?".into()).await }
        });
        let sent = vscode.out.recv().await.expect("asked");
        vscode.entry.peer.settle(
            &sent["id"],
            Err(json!({"code": -32601, "message": "no handler"})),
        );
        assert_eq!(asking.await.unwrap(), Asked::Unanswered);
    }
}
