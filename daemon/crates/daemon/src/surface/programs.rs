//! Programs and the shell: one program service per brick, shared by every client, so any
//! client's stop reaches the program another started. Stop and emergency stop never wait for a
//! lease.

use std::sync::Arc;
use std::time::Duration;

use ev3_contract::{
    ContractError, DeployParams, DeployResult, Notification, ProgramState, ProgramStateChanged,
    ProgramSubscription, ProgramsRunParams, ProgramsStatusParams, ShellResult, ShellRunParams,
};
use ev3_runtime::{
    BrickProgramLink, DeployFile, DeployRequest, DeployServices, ProgramOptions, ProgramService,
    StartOptions, deploy_and_run, run_shell,
};
use tokio::time::Instant;

use super::files::cancel_flag;
use super::{Subscription, Surface, encoding, errors, requester_of};
use crate::access::Operation;
use crate::log::Level;
use crate::rpc::RequestContext;

/// How long a start may wait out a lost route, as a command does.
const START_DEADLINE: Duration = Duration::from_secs(15);
/// The longest `programs/status` waits for a change.
const MAX_STATUS_WAIT_MS: u64 = 120_000;

/// What `endedBy` says once the latest start, number `run_seq`, is no longer running: the client
/// whose stop came after it, or `brick` when none did (the program ran to its end, or the brick's
/// buttons stopped it; the firmware does not tell these apart). Nothing while a program runs,
/// before any start, or for a start this daemon did not send itself, whose ending it did not see.
fn ended_by(
    running: bool,
    run_seq: u64,
    started_here: Option<u64>,
    stopped_by: Option<&String>,
) -> Option<String> {
    if running || run_seq == 0 || started_here != Some(run_seq) {
        return None;
    }
    Some(
        stopped_by
            .cloned()
            .unwrap_or_else(|| ENDED_ON_THE_BRICK.to_owned()),
    )
}

/// `endedBy` of a program no client stopped.
pub const ENDED_ON_THE_BRICK: &str = "brick";

impl Surface {
    /// The brick's program service, made on first use.
    fn programs_of(&self, brick_id: &str) -> ProgramService {
        if let Some(service) = self.lock().programs.get(brick_id) {
            return service.clone();
        }
        let shared = self.shared.clone();
        let interval = Arc::new(move || {
            shared
                .settings
                .lock()
                .expect("settings lock")
                .number("programs.statusIntervalMs")
                .unwrap_or(1000.0)
        });
        let service = ProgramService::new(
            Arc::new(BrickProgramLink::new(self.runtime.bricks.clone(), brick_id)),
            ProgramOptions::default(),
            Some(self.runtime.program_rows.follower(brick_id, interval)),
            Some(self.activity.clone()),
        );
        self.lock()
            .programs
            .entry(brick_id.to_owned())
            .or_insert(service)
            .clone()
    }

    fn program_state(&self, brick_id: &str, running: bool) -> ProgramState {
        let run_seq = self.runs.last(brick_id);
        let state = self.lock();
        ProgramState {
            brick_id: brick_id.to_owned(),
            running,
            run_seq,
            ended_by: ended_by(
                running,
                run_seq,
                state.started_here.get(brick_id).copied(),
                state.stopped_by.get(brick_id),
            ),
        }
    }

    /// The next start's number on the brick, written to `runs.json` before the start is sent, so
    /// a daemon that replaces this one never hands out a number already used.
    fn next_run(&self, brick_id: &str) -> u64 {
        self.lock().stopped_by.remove(brick_id);
        let (seq, written) = self.runs.next(brick_id);
        if let Err(warning) = written {
            self.shared.log.warn(&warning);
        }
        self.lock().started_here.insert(brick_id.to_owned(), seq);
        seq
    }

    pub async fn programs_deploy_and_run(
        self: &Arc<Self>,
        cx: &RequestContext,
        params: DeployParams,
    ) -> Result<DeployResult, ContractError> {
        // Local paths first, before anything else about the request.
        let mut local = Vec::with_capacity(params.files.len());
        for file in &params.files {
            local.push(
                file.local_path
                    .as_deref()
                    .map(|path| self.local_path(path, "localPath"))
                    .transpose()?,
            );
        }
        let brick_id = self.brick_of(cx, params.brick.as_deref()).await?;
        for file in &params.files {
            self.allowed(Operation::Write, Some(&file.remote_path))?;
        }
        self.allowed(Operation::Run, Some(&params.run_path))?;
        let mut files = Vec::with_capacity(params.files.len());
        for (file, local) in params.files.iter().zip(local) {
            let (content, inline) = match (local, &file.content) {
                (Some(path), _) => (
                    self.read_local(file.local_path.as_deref().unwrap_or_default(), &path)?,
                    false,
                ),
                (None, Some(content)) => (encoding::decode(content, "content")?, true),
                (None, None) => {
                    return Err(ContractError::new(
                        ev3_contract::ErrorCode::InvalidRequest,
                        format!("{} needs localPath or content.", file.remote_path),
                    ));
                }
            };
            files.push(DeployFile {
                path: file.remote_path.clone(),
                content,
                inline,
                skip_if_same: file.skip_if_same_md5 == Some(true),
            });
        }
        let surface = self.clone();
        let requester = requester_of(&cx.client);
        let fs = self.filesystem(cx, &brick_id);
        let programs = self.programs_of(&brick_id);
        let (brick, program) = (brick_id.clone(), params.run_path.clone());
        let name = cx.client.info.name.clone();
        self.leased(cx, &brick_id, move |token| async move {
            let seq = surface.next_run(&brick);
            let cancel = cancel_flag(&token);
            let report = deploy_and_run(
                DeployServices {
                    programs: &programs,
                    files: &fs.files,
                    transfer: &fs.transfer,
                },
                &requester,
                DeployRequest {
                    files,
                    program: program.clone(),
                    deadline: None,
                    cancel: Some(cancel.flag.clone()),
                },
            )
            .await
            .map_err(|e| errors::from_program(&e))?;
            surface.shared.log.write(
                Level::Info,
                Some(&name),
                &format!(
                    "Deployed {} file(s), skipped {}, started {program}: {:?}",
                    report.uploaded.len(),
                    report.skipped.len(),
                    report.outcome
                ),
            );
            Ok(DeployResult {
                brick_id: brick,
                outcome: report.outcome,
                run_seq: seq,
                uploaded: report.uploaded,
                skipped: report.skipped,
            })
        })
        .await
    }

    pub async fn programs_run(
        self: &Arc<Self>,
        cx: &RequestContext,
        params: ProgramsRunParams,
    ) -> Result<DeployResult, ContractError> {
        let brick_id = self.brick_of(cx, params.brick.as_deref()).await?;
        self.allowed(Operation::Run, Some(&params.path))?;
        let surface = self.clone();
        let requester = requester_of(&cx.client);
        let programs = self.programs_of(&brick_id);
        let (brick, path, replace) = (brick_id.clone(), params.path, params.replace == Some(true));
        self.leased(cx, &brick_id, move |token| async move {
            let seq = surface.next_run(&brick);
            let cancel = cancel_flag(&token);
            let outcome = programs
                .start(
                    &path,
                    &requester,
                    StartOptions {
                        replace,
                        deadline: Some(Instant::now() + START_DEADLINE),
                        cancel: Some(cancel.flag.clone()),
                        ..StartOptions::default()
                    },
                )
                .await
                .map_err(|e| errors::from_program(&e))?;
            Ok(DeployResult {
                brick_id: brick,
                outcome,
                run_seq: seq,
                uploaded: Vec::new(),
                skipped: Vec::new(),
            })
        })
        .await
    }

    /// Never behind a lease: a stop reaches the brick at once from any client.
    pub async fn programs_stop(
        &self,
        cx: &RequestContext,
        brick: Option<String>,
        emergency: bool,
    ) -> Result<ProgramState, ContractError> {
        let brick_id = self.brick_of(cx, brick.as_deref()).await?;
        let programs = self.programs_of(&brick_id);
        let requester = requester_of(&cx.client);
        self.lock()
            .stopped_by
            .insert(brick_id.clone(), requester.name.clone());
        if emergency {
            programs.emergency_stop(&requester).await
        } else {
            programs.stop(&requester).await
        }
        .map_err(|e| errors::from_program(&e))?;
        let lease = self
            .leases
            .holder(&brick_id)
            .map(|holder| format!(" (lease held by {holder})"))
            .unwrap_or_default();
        self.shared.log.write(
            Level::Info,
            Some(&requester.name),
            &format!(
                "{} on {brick_id}{lease}",
                if emergency { "Emergency stop" } else { "Stop" }
            ),
        );
        let running = programs
            .is_running()
            .await
            .map_err(|e| errors::from_program(&e))?;
        Ok(self.program_state(&brick_id, running))
    }

    pub async fn programs_status(
        &self,
        cx: &RequestContext,
        params: ProgramsStatusParams,
    ) -> Result<ProgramState, ContractError> {
        let brick_id = self.brick_of(cx, params.brick.as_deref()).await?;
        let programs = self.programs_of(&brick_id);
        let wait = params.wait_ms.unwrap_or(0).min(MAX_STATUS_WAIT_MS);
        // Listening before the state is read: a change between the two is not missed.
        let mut changes = if wait > 0 {
            programs.subscribe().ok()
        } else {
            None
        };
        let now = programs
            .is_running()
            .await
            .map_err(|e| errors::from_program(&e))?;
        let Some(changes) = changes.as_mut() else {
            return Ok(self.program_state(&brick_id, now));
        };
        let changed = async {
            while let Some(running) = changes.next().await {
                if running != now {
                    return running;
                }
            }
            now
        };
        let running = tokio::select! {
            running = changed => running,
            () = tokio::time::sleep(Duration::from_millis(wait)) => now,
            () = cx.cancel.cancelled() => now,
        };
        Ok(self.program_state(&brick_id, running))
    }

    pub async fn programs_subscribe(
        self: &Arc<Self>,
        cx: &RequestContext,
        brick: Option<String>,
    ) -> Result<ProgramSubscription, ContractError> {
        let brick_id = self.brick_of(cx, brick.as_deref()).await?;
        let programs = self.programs_of(&brick_id);
        let mut changes = programs.subscribe().map_err(|e| errors::from_program(&e))?;
        let running = programs
            .is_running()
            .await
            .map_err(|e| errors::from_program(&e))?;
        let id = super::new_id();
        let (surface, client, brick, sub) = (
            Arc::downgrade(self),
            cx.client.clone(),
            brick_id.clone(),
            id.clone(),
        );
        let task = tokio::spawn(async move {
            while let Some(running) = changes.next().await {
                let Some(surface) = surface.upgrade() else {
                    return;
                };
                let state = surface.program_state(&brick, running);
                let notification = Notification::ProgramsStateChanged(ProgramStateChanged {
                    subscription_id: sub.clone(),
                    state,
                });
                if let Ok(params) = notification.params() {
                    client.peer.notify(notification.method(), params);
                }
            }
        })
        .abort_handle();
        self.lock()
            .subscriptions
            .entry(cx.client.id)
            .or_default()
            .insert(id.clone(), Subscription::Program(task));
        Ok(ProgramSubscription {
            subscription_id: id,
            state: self.program_state(&brick_id, running),
        })
    }

    pub async fn shell_run(
        &self,
        cx: &RequestContext,
        params: ShellRunParams,
    ) -> Result<ShellResult, ContractError> {
        let brick_id = self.brick_of(cx, params.brick.as_deref()).await?;
        self.allowed(Operation::Shell, None)?;
        let link = BrickProgramLink::new(self.runtime.bricks.clone(), brick_id.as_str());
        let writes = self.writes(&cx.client);
        let (brick, command) = (brick_id.clone(), params.command);
        let name = cx.client.info.name.clone();
        let shared = self.shared.clone();
        self.leased(cx, &brick_id, move |_| async move {
            let status = run_shell(&link, &command, Some(&writes))
                .await
                .map_err(|e| errors::from_shell(&e))?;
            shared.log.write(
                Level::Info,
                Some(&name),
                &format!("Shell on {brick}: {command} -> {status}"),
            );
            Ok(ShellResult {
                brick_id: brick,
                status: i64::from(status),
            })
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::ended_by;

    #[test]
    fn ended_by_names_the_stopper_or_the_brick_only_for_a_start_this_daemon_sent() {
        let client = "VS Code".to_owned();
        assert_eq!(
            ended_by(false, 3, Some(3), Some(&client)),
            Some(client.clone())
        );
        assert_eq!(ended_by(false, 3, Some(3), None).as_deref(), Some("brick"));
        assert_eq!(ended_by(true, 3, Some(3), None), None, "it still runs");
        assert_eq!(ended_by(false, 0, None, None), None, "nothing started yet");
        assert_eq!(
            ended_by(false, 3, None, None),
            None,
            "a replaced daemon sent it"
        );
        assert_eq!(
            ended_by(false, 4, Some(3), Some(&client)),
            None,
            "another daemon started 4"
        );
    }
}
