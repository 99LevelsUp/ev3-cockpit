//! Which brick a client means. A brick is named by its id or by its name, the name compared without
//! case; a name that fits several bricks is refused with the candidates, since a fresh brick is
//! called "EV3" and a classroom has many.
//!
//! Only the CLI may leave the brick out, and then only when exactly one brick is connected: a person
//! at a terminal with one brick should not have to type its name. An agent always names its brick.
//!
//! A just-started daemon has not heard every brick yet, so a name not found waits for the first
//! discovery round before it is refused.

use std::future::Future;

use ev3_contract::{BrickCandidate, ClientKind, ContractError, ErrorCode};

/// One brick as the resolver sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolverBrick {
    pub brick_id: String,
    pub name: String,
    pub connected: bool,
}

fn matching(bricks: &[ResolverBrick], wanted: &str) -> Vec<ResolverBrick> {
    let by_id: Vec<_> = bricks
        .iter()
        .filter(|b| b.brick_id == wanted)
        .cloned()
        .collect();
    if !by_id.is_empty() {
        return by_id;
    }
    let wanted = wanted.trim().to_lowercase();
    bricks
        .iter()
        .filter(|b| b.name.trim().to_lowercase() == wanted)
        .cloned()
        .collect()
}

fn candidates(bricks: &[ResolverBrick]) -> Vec<BrickCandidate> {
    bricks
        .iter()
        .map(|b| BrickCandidate {
            brick_id: b.brick_id.clone(),
            name: b.name.clone(),
        })
        .collect()
}

/// The brick id `wanted` names, for a client of `kind`.
pub async fn resolve_brick<S: Future<Output = ()>>(
    bricks: impl Fn() -> Vec<ResolverBrick>,
    discovery_settled: impl FnOnce() -> S,
    wanted: Option<&str>,
    kind: ClientKind,
) -> Result<String, ContractError> {
    let Some(wanted) = wanted.filter(|w| !w.is_empty()) else {
        if kind != ClientKind::Cli {
            return Err(ContractError::new(
                ErrorCode::InvalidRequest,
                "Name the brick by its id or its name.",
            ));
        }
        let connected: Vec<_> = bricks().into_iter().filter(|b| b.connected).collect();
        return match connected.as_slice() {
            [one] => Ok(one.brick_id.clone()),
            [] => Err(ContractError::new(
                ErrorCode::NotConnected,
                "No brick is connected: connect one, or name the brick.",
            )),
            several => {
                let mut error = ContractError::new(
                    ErrorCode::BrickAmbiguous,
                    "Several bricks are connected: name the one you mean.",
                );
                error.data.candidates = candidates(several);
                Err(error)
            }
        };
    };
    let mut found = matching(&bricks(), wanted);
    if found.is_empty() {
        discovery_settled().await;
        found = matching(&bricks(), wanted);
    }
    match found.as_slice() {
        [one] => Ok(one.brick_id.clone()),
        [] => Err(ContractError::new(
            ErrorCode::BrickNotFound,
            format!("No brick is called {wanted}: list the bricks for their names and ids."),
        )),
        several => {
            let mut error = ContractError::new(
                ErrorCode::BrickAmbiguous,
                format!("Several bricks are called {wanted}: name one by its id."),
            );
            error.data.candidates = candidates(several);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn brick(id: &str, name: &str, connected: bool) -> ResolverBrick {
        ResolverBrick {
            brick_id: id.into(),
            name: name.into(),
            connected,
        }
    }

    async fn resolve(
        list: &[ResolverBrick],
        wanted: Option<&str>,
        kind: ClientKind,
    ) -> Result<String, ContractError> {
        let list = list.to_vec();
        resolve_brick(move || list.clone(), || async {}, wanted, kind).await
    }

    #[tokio::test]
    async fn a_brick_is_found_by_id_or_by_its_name_in_any_case() {
        let list = [brick("001653F00A0A", "CCC", false)];
        assert_eq!(
            resolve(&list, Some("001653F00A0A"), ClientKind::Mcp)
                .await
                .unwrap(),
            "001653F00A0A"
        );
        assert_eq!(
            resolve(&list, Some("ccc"), ClientKind::Mcp).await.unwrap(),
            "001653F00A0A"
        );
    }

    #[tokio::test]
    async fn a_name_two_bricks_share_is_refused_listing_both() {
        let list = [
            brick("001653F00A0A", "EV3", true),
            brick("001653F00B0B", "EV3", false),
        ];
        let error = resolve(&list, Some("EV3"), ClientKind::Cli)
            .await
            .unwrap_err();
        assert_eq!(error.data.code, ErrorCode::BrickAmbiguous);
        assert_eq!(error.data.candidates.len(), 2);
        assert_eq!(
            resolve(&list, Some("001653F00B0B"), ClientKind::Cli)
                .await
                .unwrap(),
            "001653F00B0B"
        );
    }

    #[tokio::test]
    async fn a_name_not_heard_yet_waits_for_the_first_discovery_round() {
        let list = Arc::new(Mutex::new(Vec::new()));
        let found = resolve_brick(
            {
                let list = list.clone();
                move || list.lock().unwrap().clone()
            },
            {
                let list = list.clone();
                move || async move {
                    list.lock()
                        .unwrap()
                        .push(brick("001653F00C0C", "CCC", false));
                }
            },
            Some("CCC"),
            ClientKind::Cli,
        )
        .await
        .unwrap();
        assert_eq!(found, "001653F00C0C");
        let error = resolve(&[], Some("Nobody"), ClientKind::Cli)
            .await
            .unwrap_err();
        assert_eq!(error.data.code, ErrorCode::BrickNotFound);
    }

    #[tokio::test]
    async fn the_cli_alone_may_leave_out_the_one_connected_brick() {
        let one = [
            brick("001653F00A0A", "CCC", true),
            brick("001653F00B0B", "BBB", false),
        ];
        assert_eq!(
            resolve(&one, None, ClientKind::Cli).await.unwrap(),
            "001653F00A0A"
        );
        for kind in [ClientKind::Mcp, ClientKind::Vscode, ClientKind::Addon] {
            let error = resolve(&one, None, kind).await.unwrap_err();
            assert_eq!(error.data.code, ErrorCode::InvalidRequest);
        }
        let two = [
            brick("001653F00A0A", "CCC", true),
            brick("001653F00B0B", "BBB", true),
        ];
        assert_eq!(
            resolve(&two, None, ClientKind::Cli)
                .await
                .unwrap_err()
                .data
                .code,
            ErrorCode::BrickAmbiguous
        );
        assert_eq!(
            resolve(&[], None, ClientKind::Cli)
                .await
                .unwrap_err()
                .data
                .code,
            ErrorCode::NotConnected
        );
    }
}
