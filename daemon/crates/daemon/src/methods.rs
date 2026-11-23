//! The daemon's answers to the contract's requests: the daemon's own (status, exit, log, settings)
//! here, every brick method through the surface.

use std::sync::Arc;

use ev3_contract::*;

use crate::lifecycle::{self, ExitKind};
use crate::log::Level;
use crate::questions::{Asked, Topic};
use crate::rpc::RequestContext;
use crate::state::{ClientEntry, ExitReason, Shared};
use crate::surface::{Surface, requester_of};

/// The handler `dispatch` calls.
pub struct Daemon {
    shared: Arc<Shared>,
    surface: Arc<Surface>,
}

impl Daemon {
    pub fn new(shared: Arc<Shared>, surface: Arc<Surface>) -> Self {
        Self { shared, surface }
    }

    pub fn surface(&self) -> &Arc<Surface> {
        &self.surface
    }

    /// A client's connection closed.
    pub fn client_left(&self, client: &ClientEntry) {
        self.surface.client_left(client);
    }

    fn status(&self) -> DaemonStatus {
        let identity = &self.shared.identity;
        DaemonStatus {
            bricks: self.surface.brick_status(),
            build_id: identity.build_id.clone(),
            build_kind: identity.build_kind,
            channel: identity.channel_path.clone(),
            clients: self.surface.client_status(),
            contract_version: std::num::NonZeroU64::new(u64::from(CONTRACT_VERSION))
                .expect("the contract version is at least 1"),
            log_path: self.shared.log.path().display().to_string(),
            mode: identity.mode,
            pid: u64::from(identity.pid),
            started_at: identity.started_at,
            version: identity.version.clone(),
        }
    }

    /// An exit request, judged from the asking client's hello (see [`crate::lifecycle`]): a
    /// replacement goes ahead at once, a restart after a person's yes; either ends the daemon right
    /// after the answer once no write is in progress, waiting at most a minute. A refusal is an
    /// answer with the reason, never an error, so a client on any contract version can read it.
    async fn exit(&self, cx: &RequestContext) -> DaemonExitResult {
        let identity = &self.shared.identity;
        let client = &cx.client.info;
        let log = |level, text: &str| self.shared.log.write(level, Some(&client.name), text);
        let refused = |reason: String| {
            log(Level::Info, &reason);
            DaemonExitResult {
                accepted: false,
                reason: Some(reason),
            }
        };
        match lifecycle::judge(identity.build_kind, &identity.version, client) {
            ExitKind::Replacement => log(
                Level::Info,
                &format!(
                    "Asked to exit by a {} {} client {}: it replaces this {} daemon {}.",
                    client.build_kind,
                    client.kind,
                    client.version,
                    identity.build_kind,
                    identity.version
                ),
            ),
            ExitKind::Restart => {
                log(Level::Info, "Asked to restart; asking a person.");
                let asked = lifecycle::ask_restart(
                    &self.surface.questions,
                    &self.shared.clients(),
                    &requester_of(&cx.client),
                )
                .await;
                if let Err(reason) = asked {
                    return refused(reason);
                }
            }
        }
        let surface = &self.surface;
        let waited = lifecycle::wait_for_no_write(
            || surface.write_in_progress(),
            || surface.leases.close_if_idle(),
            lifecycle::WRITE_WAIT,
            |what| log(Level::Info, &format!("Exiting once {what} has finished.")),
        )
        .await;
        if let Err(reason) = waited {
            return refused(reason);
        }
        log(Level::Info, "Exiting: no write is in progress.");
        self.shared.mark_exiting();
        let shared = self.shared.clone();
        cx.after_reply(move || shared.request_exit(ExitReason::Requested));
        DaemonExitResult {
            accepted: true,
            reason: None,
        }
    }

    /// Changes a setting; a dangerous change goes ahead only after a person said yes.
    async fn set_setting(
        &self,
        cx: &RequestContext,
        params: SettingsSetParams,
    ) -> Result<SettingValue, ContractError> {
        let dangerous = self
            .shared
            .settings
            .lock()
            .expect("settings lock")
            .needs_person(&params.key, &params.value)?;
        let confirmed = match dangerous {
            None => false,
            Some(spec) => {
                let command = crate::settings::person_command(&spec, &params.value);
                let asked = self
                    .surface
                    .questions
                    .ask(
                        &self.shared.clients(),
                        &requester_of(&cx.client),
                        Topic::Setting {
                            key: spec.key.clone(),
                            value: params.value.clone(),
                        },
                        format!(
                            "Change {} to {}? ({})",
                            spec.cli_key,
                            crate::settings::describe(&params.value),
                            spec.description
                        ),
                    )
                    .await;
                match asked {
                    Asked::Yes => true,
                    Asked::No => {
                        return Err(ContractError::new(
                            ErrorCode::Cancelled,
                            format!(
                                "{} was not changed: the person said no. ({command})",
                                spec.cli_key
                            ),
                        ));
                    }
                    // Refused naming the command a person runs.
                    Asked::Unanswered | Asked::NoPerson => false,
                }
            }
        };
        let mut store = self.shared.settings.lock().expect("settings lock");
        let before = store.access_mode();
        let changed = store.set(&params.key, params.value, cx.client.kind(), confirmed)?;
        let after = store.access_mode();
        drop(store);
        self.shared.log.write(
            crate::log::Level::Info,
            Some(&cx.client.info.name),
            &format!("Setting {} changed.", changed.spec.key),
        );
        self.surface.settings_changed();
        self.shared
            .broadcast(&Notification::SettingsChanged(SettingChanged {
                setting: changed.clone(),
            }));
        if before != after {
            self.shared
                .broadcast(&Notification::SettingsAccessModeChanged(AccessModeState {
                    mode: after,
                }));
        }
        Ok(changed)
    }
}

impl Methods for Daemon {
    type Context = RequestContext;

    async fn daemon_status(
        &self,
        _cx: &RequestContext,
        _params: EmptyParams,
    ) -> Result<DaemonStatus, ContractError> {
        Ok(self.status())
    }

    async fn daemon_exit(
        &self,
        cx: &RequestContext,
        _params: DaemonExitParams,
    ) -> Result<DaemonExitResult, ContractError> {
        Ok(self.exit(cx).await)
    }

    async fn log_notice(
        &self,
        cx: &RequestContext,
        params: LogNoticeParams,
    ) -> Result<(), ContractError> {
        let level = match params.level {
            LogNoticeParamsLevel::Info => crate::log::Level::Info,
            LogNoticeParamsLevel::Warning => crate::log::Level::Warn,
            LogNoticeParamsLevel::Error => crate::log::Level::Error,
        };
        self.shared.log.write(
            level,
            Some(&cx.client.info.name),
            &format!("Shown to a person: {}", params.text),
        );
        Ok(())
    }

    async fn bricks_list(
        &self,
        _cx: &RequestContext,
        params: BricksListParams,
    ) -> Result<BrickList, ContractError> {
        Ok(self.surface.bricks_list(params).await)
    }

    async fn bricks_connect(
        &self,
        cx: &RequestContext,
        params: BricksConnectParams,
    ) -> Result<ContractBrick, ContractError> {
        self.surface.bricks_connect(cx, params).await
    }

    async fn bricks_disconnect(
        &self,
        cx: &RequestContext,
        params: BricksDisconnectParams,
    ) -> Result<BricksDisconnectResult, ContractError> {
        self.surface.bricks_disconnect(cx, params).await
    }

    async fn bricks_info(
        &self,
        cx: &RequestContext,
        params: BrickParams,
    ) -> Result<BrickInfo, ContractError> {
        self.surface.bricks_info(cx, params.brick).await
    }

    async fn bricks_storage(
        &self,
        cx: &RequestContext,
        params: BrickParams,
    ) -> Result<StorageUsage, ContractError> {
        self.surface.bricks_storage(cx, params.brick).await
    }

    async fn bricks_pair(
        &self,
        cx: &RequestContext,
        params: BrickParams,
    ) -> Result<PairingResult, ContractError> {
        self.surface.bricks_pair(cx, params.brick).await
    }

    async fn bricks_forget(
        &self,
        cx: &RequestContext,
        params: BrickParams,
    ) -> Result<ForgetResult, ContractError> {
        self.surface.bricks_forget(cx, params.brick).await
    }

    async fn bricks_clear_bluetooth_list(
        &self,
        cx: &RequestContext,
        params: BrickParams,
    ) -> Result<ClearListResult, ContractError> {
        self.surface
            .bricks_clear_bluetooth_list(cx, params.brick)
            .await
    }

    async fn bricks_inquiry(
        &self,
        _cx: &RequestContext,
        _params: EmptyParams,
    ) -> Result<(), ContractError> {
        self.surface.bricks_inquiry().await;
        Ok(())
    }

    async fn files_list(
        &self,
        cx: &RequestContext,
        params: PathParams,
    ) -> Result<FsListing, ContractError> {
        self.surface.files_list(cx, params).await
    }

    async fn files_exists(
        &self,
        cx: &RequestContext,
        params: PathParams,
    ) -> Result<FileExists, ContractError> {
        self.surface.files_exists(cx, params).await
    }

    async fn files_size(
        &self,
        cx: &RequestContext,
        params: PathParams,
    ) -> Result<FileSize, ContractError> {
        self.surface.files_size(cx, params).await
    }

    async fn files_read(
        &self,
        cx: &RequestContext,
        params: FilesReadParams,
    ) -> Result<FilesReadResult, ContractError> {
        self.surface.files_read(cx, params).await
    }

    async fn files_write(
        &self,
        cx: &RequestContext,
        params: FilesWriteParams,
    ) -> Result<FilesWriteResult, ContractError> {
        self.surface.files_write(cx, params).await
    }

    async fn files_make_directory(
        &self,
        cx: &RequestContext,
        params: PathParams,
    ) -> Result<(), ContractError> {
        self.surface.files_make_directory(cx, params).await
    }

    async fn files_remove(
        &self,
        cx: &RequestContext,
        params: FilesRemoveParams,
    ) -> Result<RemoveReport, ContractError> {
        self.surface.files_remove(cx, params).await
    }

    async fn files_remove_paths(
        &self,
        cx: &RequestContext,
        params: FilesRemovePathsParams,
    ) -> Result<RemoveReport, ContractError> {
        self.surface.files_remove_paths(cx, params).await
    }

    async fn files_move(
        &self,
        cx: &RequestContext,
        params: FilesMoveParams,
    ) -> Result<(), ContractError> {
        self.surface.files_move(cx, params).await
    }

    async fn transfer_begin(
        &self,
        cx: &RequestContext,
        params: TransferBeginParams,
    ) -> Result<TransferBeginResult, ContractError> {
        self.surface.transfer_begin(cx, params)
    }

    async fn transfer_write(
        &self,
        cx: &RequestContext,
        params: TransferWriteParams,
    ) -> Result<(), ContractError> {
        self.surface.transfer_write(cx, params)
    }

    async fn transfer_read(
        &self,
        cx: &RequestContext,
        params: TransferHandleParams,
    ) -> Result<TransferChunk, ContractError> {
        self.surface.transfer_read(cx, params)
    }

    async fn transfer_close(
        &self,
        cx: &RequestContext,
        params: TransferHandleParams,
    ) -> Result<(), ContractError> {
        self.surface.transfer_close(cx, params);
        Ok(())
    }

    async fn programs_deploy_and_run(
        &self,
        cx: &RequestContext,
        params: DeployParams,
    ) -> Result<DeployResult, ContractError> {
        self.surface.programs_deploy_and_run(cx, params).await
    }

    async fn programs_run(
        &self,
        cx: &RequestContext,
        params: ProgramsRunParams,
    ) -> Result<DeployResult, ContractError> {
        self.surface.programs_run(cx, params).await
    }

    async fn programs_stop(
        &self,
        cx: &RequestContext,
        params: BrickParams,
    ) -> Result<ProgramState, ContractError> {
        self.surface.programs_stop(cx, params.brick, false).await
    }

    async fn programs_emergency_stop(
        &self,
        cx: &RequestContext,
        params: BrickParams,
    ) -> Result<ProgramState, ContractError> {
        self.surface.programs_stop(cx, params.brick, true).await
    }

    async fn programs_status(
        &self,
        cx: &RequestContext,
        params: ProgramsStatusParams,
    ) -> Result<ProgramState, ContractError> {
        self.surface.programs_status(cx, params).await
    }

    async fn programs_subscribe(
        &self,
        cx: &RequestContext,
        params: BrickParams,
    ) -> Result<ProgramSubscription, ContractError> {
        self.surface.programs_subscribe(cx, params.brick).await
    }

    async fn shell_run(
        &self,
        cx: &RequestContext,
        params: ShellRunParams,
    ) -> Result<ShellResult, ContractError> {
        self.surface.shell_run(cx, params).await
    }

    async fn settings_list(
        &self,
        _cx: &RequestContext,
        _params: EmptyParams,
    ) -> Result<SettingList, ContractError> {
        let settings = self.shared.settings.lock().expect("settings lock").list();
        Ok(SettingList { settings })
    }

    async fn settings_set(
        &self,
        cx: &RequestContext,
        params: SettingsSetParams,
    ) -> Result<SettingValue, ContractError> {
        self.set_setting(cx, params).await
    }

    async fn settings_access_mode(
        &self,
        _cx: &RequestContext,
        _params: EmptyParams,
    ) -> Result<AccessModeState, ContractError> {
        let mode = self
            .shared
            .settings
            .lock()
            .expect("settings lock")
            .access_mode();
        Ok(AccessModeState { mode })
    }

    async fn telemetry_rows(
        &self,
        _cx: &RequestContext,
        _params: EmptyParams,
    ) -> Result<TelemetryRowList, ContractError> {
        Ok(self.surface.telemetry_rows())
    }

    async fn telemetry_subscribe(
        &self,
        cx: &RequestContext,
        params: TelemetrySubscribeParams,
    ) -> Result<TelemetrySubscription, ContractError> {
        self.surface.telemetry_subscribe(cx, params).await
    }

    async fn telemetry_foreground(
        &self,
        cx: &RequestContext,
        params: TelemetryForegroundParams,
    ) -> Result<(), ContractError> {
        self.surface.telemetry_foreground(cx, params).await
    }

    async fn chain_get(
        &self,
        cx: &RequestContext,
        params: BrickParams,
    ) -> Result<ContractChain, ContractError> {
        self.surface.chain_get(cx, params.brick).await
    }

    async fn chain_follow(
        &self,
        cx: &RequestContext,
        params: BrickParams,
    ) -> Result<ChainSubscription, ContractError> {
        self.surface.chain_follow(cx, params.brick).await
    }

    async fn subscriptions_cancel(
        &self,
        cx: &RequestContext,
        params: SubscriptionParams,
    ) -> Result<(), ContractError> {
        self.surface
            .cancel_subscription(cx.client.id, &params.subscription_id);
        Ok(())
    }
}
