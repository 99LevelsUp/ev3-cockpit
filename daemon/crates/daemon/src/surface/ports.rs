//! The runtime's ports as the daemon answers them: consent through a question to a person, write
//! activity into the daemon's count of writes in progress, this computer's Bluetooth name, and the
//! log.

use std::sync::Arc;

use async_trait::async_trait;
use ev3_runtime::{
    ActivityEvent, ActivityPort, BrickLog, ConsentAnswer, ConsentPort, ConsentRequest,
    ConsentSubject, RadioName,
};

use crate::log::Level;
use crate::questions::{Asked, Questions, Topic};
use crate::state::Shared;

use super::runtime::Bluetooth;

/// Asks a person through the daemon's questions.
pub struct DaemonConsent {
    pub shared: Arc<Shared>,
    pub questions: Arc<Questions>,
}

#[async_trait]
impl ConsentPort for DaemonConsent {
    async fn ask(&self, request: ConsentRequest) -> ConsentAnswer {
        let topic = match &request.subject {
            ConsentSubject::Forget { brick_id } => Topic::Forget {
                brick_id: brick_id.clone(),
            },
            ConsentSubject::ClearBluetoothList {
                brick_id,
                entries,
                includes_this_computer,
                this_computer,
            } => Topic::ClearBluetoothList {
                brick_id: brick_id.clone(),
                entries: entries.clone(),
                includes_this_computer: *includes_this_computer,
                this_computer: this_computer.clone(),
            },
            ConsentSubject::ReleaseSlots { brick_id } => Topic::Sweep {
                brick_id: brick_id.clone(),
            },
        };
        let sweep = matches!(topic, Topic::Sweep { .. });
        let asked = self
            .questions
            .ask(
                &self.shared.clients(),
                &request.requester,
                topic,
                request.action.clone(),
            )
            .await;
        match asked {
            Asked::Yes => ConsentAnswer::Granted,
            Asked::No => ConsentAnswer::Declined,
            Asked::Unanswered | Asked::NoPerson => {
                if sweep {
                    self.shared.log.write(
                        Level::Warn,
                        Some(&request.requester.name),
                        "A transfer slot left open on a brick was not released: nobody answered. \
                         A person can release it from VS Code or a terminal.",
                    );
                }
                ConsentAnswer::Unanswered
            }
        }
    }
}

/// Counts the writes in progress, for the daemon's lifecycle: an exit waits for them.
pub struct DaemonActivity {
    pub shared: Arc<Shared>,
}

impl ActivityPort for DaemonActivity {
    fn report(&self, event: ActivityEvent) {
        self.shared
            .write_reported(matches!(event, ActivityEvent::WriteStarted(_)));
    }
}

/// This computer's Bluetooth name, from the Bluetooth provider.
pub struct ProviderRadioName {
    pub bluetooth: Bluetooth,
}

#[async_trait]
impl RadioName for ProviderRadioName {
    async fn radio_name(&self) -> Option<String> {
        self.bluetooth.radio_name().await
    }
}

/// The runtime's log lines in the daemon's log.
pub struct DaemonLog {
    pub shared: Arc<Shared>,
}

impl BrickLog for DaemonLog {
    fn warn(&self, message: &str) {
        self.shared.log.warn(message);
    }

    fn info(&self, message: &str) {
        self.shared.log.info(message);
    }
}

#[cfg(target_os = "linux")]
pub use linux::{BluezActivity, BluezConsent};

#[cfg(target_os = "linux")]
mod linux {
    use std::sync::Arc;

    use async_trait::async_trait;
    use ev3_transports::bt_linux::access::{Activity, Answer, Consent, Question, QuestionKind};

    use crate::questions::{Asked, Questions};
    use crate::state::Shared;

    /// The Linux Bluetooth provider's group question, put to the VS Code window or terminal that
    /// connected last; no client's request raised it.
    pub struct BluezConsent {
        pub shared: Arc<Shared>,
        pub questions: Arc<Questions>,
    }

    #[async_trait]
    impl Consent for BluezConsent {
        fn can_ask(&self) -> bool {
            Questions::can_ask(&self.shared.clients())
        }

        async fn ask(&self, question: Question) -> Answer {
            let Question {
                kind,
                text,
                details,
            } = question;
            let asked = self
                .questions
                .ask_unrequested(
                    &self.shared.clients(),
                    move |question_id, timeout_ms| match kind {
                        QuestionKind::BluetoothAccess => ev3_contract::Question::BluetoothAccess {
                            details,
                            question_id,
                            text,
                            timeout_ms,
                        },
                        QuestionKind::BluetoothCheckAgain => {
                            ev3_contract::Question::BluetoothCheckAgain {
                                details,
                                question_id,
                                text,
                                timeout_ms,
                            }
                        }
                    },
                )
                .await;
            match asked {
                Asked::Yes => Answer::Yes,
                Asked::No => Answer::No,
                Asked::Unanswered | Asked::NoPerson => Answer::Keep,
            }
        }
    }

    /// The Linux Bluetooth provider's lines in the daemon's log.
    pub struct BluezActivity {
        pub shared: Arc<Shared>,
    }

    impl Activity for BluezActivity {
        fn info(&self, message: &str) {
            self.shared.log.info(message);
        }

        fn warn(&self, message: &str) {
            self.shared.log.warn(message);
        }
    }
}
