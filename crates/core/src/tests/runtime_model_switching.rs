use super::*;
use futures_util::FutureExt;
use futures_util::StreamExt;
use futures_util::stream;
use std::collections::VecDeque;
use std::sync::Arc;
use sugarcode_model_provider::BoxModelFuture;
use sugarcode_model_provider::ModelOutputItem;
use sugarcode_model_provider::ModelProvider;
use sugarcode_model_provider::ModelTerminalMetadata;
use sugarcode_model_provider::ProviderContextEnvelope;
use sugarcode_model_provider::ProviderWireApi;
use sugarcode_protocol::CoreContentAsset;

#[derive(Debug)]
struct SwitchingProvider {
    requests: Arc<Mutex<Vec<ModelRequest>>>,
}

impl ModelProvider for SwitchingProvider {
    fn stream(&self, request: ModelRequest) -> BoxModelFuture<'_> {
        let answer = format!("{} completed", request.model);
        let provider_context = ProviderContextEnvelope::new(
            provider_wire_for_model(&request.model),
            Some("provider-private-response-id".to_owned()),
            b"provider-private-continuation".to_vec(),
        )
        .expect("provider context");
        self.requests.lock().expect("requests").push(request);
        async move {
            Ok(
                stream::iter(vec![Ok(ModelEvent::ResponseCompleted(ModelResponse {
                    output: vec![ModelOutputItem {
                        output_index: 0,
                        kind: ModelOutputItemKind::AssistantText {
                            phase: ModelTextPhase::Final,
                            text: answer,
                        },
                    }],
                    usage: None,
                    terminal: ModelTerminalMetadata::completed(ModelContinuation::Complete),
                    provider_context: Some(Box::new(provider_context)),
                }))])
                .boxed(),
            )
        }
        .boxed()
    }
}

struct SwitchingResolver {
    provider: Arc<dyn ModelProvider>,
}

impl ModelResolver for SwitchingResolver {
    fn resolve(&self, profile_id: Option<&str>) -> Result<ResolvedModel, ModelError> {
        let profile_id = profile_id.unwrap_or("responses_a");
        let (provider_family, wire_api) = selection_for_profile(profile_id);
        Ok(ResolvedModel {
            provider: self.provider.clone(),
            model: format!("fixture-{profile_id}"),
            profile_id: profile_id.to_string(),
            provider_family: provider_family.to_string(),
            wire_api: wire_api.to_string(),
            display_name: profile_id.to_string(),
            capabilities: ModelCapabilities::new(200_000, true, true, true, true, true),
        })
    }
}

fn selection_for_profile(profile_id: &str) -> (&'static str, &'static str) {
    if profile_id.starts_with("chat_") {
        ("openai", "openaiChatCompletions")
    } else if profile_id.starts_with("anthropic_") {
        ("anthropic", "anthropicMessages")
    } else {
        ("openai", "openaiResponses")
    }
}

fn provider_wire_for_model(model: &str) -> ProviderWireApi {
    if model.contains("chat_") {
        ProviderWireApi::OpenAiChatCompletions
    } else if model.contains("anthropic_") {
        ProviderWireApi::AnthropicMessages
    } else {
        ProviderWireApi::OpenAiResponses
    }
}

async fn wait_for_completed(events: &mut mpsc::Receiver<CoreEvent>, turn_id: &TurnId) {
    loop {
        let event = events.recv().await.expect("runtime event");
        if matches!(
            event.kind,
            CoreEventKind::TurnCompleted { turn_id: ref completed, .. } if completed == turn_id
        ) {
            return;
        }
    }
}

#[tokio::test]
async fn switching_models_and_wires_injects_one_portable_transition_instruction() {
    let mut core = Core::new();
    let started = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = Arc::new(SwitchingProvider {
        requests: requests.clone(),
    });
    let resolver = Arc::new(SwitchingResolver { provider });
    let (mut runtime, mut events) =
        CoreRuntime::new_with_model_resolver(core, resolver, None, None, None);

    let TurnStartOutcome::Accepted { turn_id: first } = runtime
        .start_text_turn_with_model(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Inspect the project".to_string()),
            Some("responses_a".to_string()),
        )
        .expect("first turn")
    else {
        panic!("asynchronous turn");
    };
    wait_for_completed(&mut events, &first).await;

    let TurnStartOutcome::Accepted { turn_id: second } = runtime
        .start_text_turn_with_model(
            CoreRequestId::new(3),
            thread_id.clone(),
            Some("What can be improved?".to_string()),
            Some("chat_a".to_string()),
        )
        .expect("second turn")
    else {
        panic!("asynchronous turn");
    };
    wait_for_completed(&mut events, &second).await;

    let TurnStartOutcome::Accepted { turn_id: third } = runtime
        .start_text_turn_with_model(
            CoreRequestId::new(4),
            thread_id.clone(),
            Some("Summarize the result".to_string()),
            Some("chat_b".to_string()),
        )
        .expect("third turn")
    else {
        panic!("asynchronous turn");
    };
    wait_for_completed(&mut events, &third).await;

    let TurnStartOutcome::Accepted { turn_id: fourth } = runtime
        .start_text_turn_with_model(
            CoreRequestId::new(5),
            thread_id,
            Some("Verify the portable result".to_string()),
            Some("responses_b".to_string()),
        )
        .expect("fourth turn")
    else {
        panic!("asynchronous turn");
    };
    wait_for_completed(&mut events, &fourth).await;

    let requests = requests.lock().expect("requests");
    assert_eq!(requests.len(), 4);
    assert_eq!(requests[0].model, "fixture-responses_a");
    assert_eq!(requests[1].model, "fixture-chat_a");
    assert_eq!(requests[2].model, "fixture-chat_b");
    assert_eq!(requests[3].model, "fixture-responses_b");
    assert!(!requests[0]
        .instructions
        .iter()
        .any(|instruction| instruction.source == ModelInstructionSource::SugarCodeModelSwitchV1));
    assert_eq!(
        requests[1]
            .instructions
            .iter()
            .filter(|instruction| {
                instruction.source == ModelInstructionSource::SugarCodeModelSwitchV1
            })
            .count(),
        1
    );
    assert_eq!(
        requests[2]
            .instructions
            .iter()
            .filter(|instruction| {
                instruction.source == ModelInstructionSource::SugarCodeModelSwitchV1
            })
            .count(),
        1
    );
    assert_eq!(
        requests[3]
            .instructions
            .iter()
            .filter(|instruction| {
                instruction.source == ModelInstructionSource::SugarCodeModelSwitchV1
            })
            .count(),
        1
    );
    assert!(requests[1].messages.iter().any(|message| {
        message.content.iter().any(|part| {
            matches!(part, ModelContentPart::Text { text, .. } if text == "fixture-responses_a completed")
        })
    }));
    assert!(!requests[1].messages.iter().any(|message| {
        message
            .content
            .iter()
            .any(|part| matches!(part, ModelContentPart::ProviderContext(_)))
    }));
    assert!(requests[2].messages.iter().any(|message| {
        message.content.iter().any(|part| {
            matches!(part, ModelContentPart::Text { text, .. } if text == "fixture-chat_a completed")
        })
    }));
    assert!(!requests[2].messages.iter().any(|message| {
        message
            .content
            .iter()
            .any(|part| matches!(part, ModelContentPart::ProviderContext(_)))
    }));
    assert!(requests[3].messages.iter().any(|message| {
        message.content.iter().any(|part| {
            matches!(part, ModelContentPart::Text { text, .. } if text == "fixture-chat_b completed")
        })
    }));
    assert!(!requests[3].messages.iter().any(|message| {
        message
            .content
            .iter()
            .any(|part| matches!(part, ModelContentPart::ProviderContext(_)))
    }));
}

#[tokio::test]
async fn every_wire_pair_switches_through_portable_history_only() {
    let profiles = ["responses_matrix", "chat_matrix", "anthropic_matrix"];

    for source in profiles {
        for target in profiles {
            if source == target {
                continue;
            }
            let mut core = Core::new();
            let CoreEventKind::ThreadStarted { thread_id } = core
                .start_thread(CoreRequestId::new(1))
                .expect("start thread")
                .kind
            else {
                panic!("thread event");
            };
            let requests = Arc::new(Mutex::new(Vec::new()));
            let provider = Arc::new(SwitchingProvider {
                requests: requests.clone(),
            });
            let resolver = Arc::new(SwitchingResolver { provider });
            let (mut runtime, mut events) =
                CoreRuntime::new_with_model_resolver(core, resolver, None, None, None);

            let TurnStartOutcome::Accepted { turn_id: first } = runtime
                .start_text_turn_with_model(
                    CoreRequestId::new(2),
                    thread_id.clone(),
                    Some("First portable turn".to_owned()),
                    Some(source.to_owned()),
                )
                .expect("source turn")
            else {
                panic!("asynchronous turn");
            };
            wait_for_completed(&mut events, &first).await;
            let TurnStartOutcome::Accepted { turn_id: second } = runtime
                .start_text_turn_with_model(
                    CoreRequestId::new(3),
                    thread_id,
                    Some("Continue after switching".to_owned()),
                    Some(target.to_owned()),
                )
                .expect("target turn")
            else {
                panic!("asynchronous turn");
            };
            wait_for_completed(&mut events, &second).await;

            let requests = requests.lock().expect("requests");
            assert_eq!(requests.len(), 2, "{source} -> {target}");
            assert_eq!(
                requests[1]
                    .instructions
                    .iter()
                    .filter(|instruction| {
                        instruction.source == ModelInstructionSource::SugarCodeModelSwitchV1
                    })
                    .count(),
                1,
                "{source} -> {target}",
            );
            assert!(requests[1].messages.iter().any(|message| {
                message.content.iter().any(|part| {
                    matches!(part, ModelContentPart::Text { text, .. }
                        if text == &format!("fixture-{source} completed"))
                })
            }));
            assert!(!requests[1].messages.iter().any(|message| {
                message
                    .content
                    .iter()
                    .any(|part| matches!(part, ModelContentPart::ProviderContext(_)))
            }));
        }
    }
}

struct ReconfiguredProfileResolver {
    provider: Arc<dyn ModelProvider>,
    selections: Mutex<VecDeque<(&'static str, &'static str, &'static str)>>,
}

impl ModelResolver for ReconfiguredProfileResolver {
    fn resolve(&self, profile_id: Option<&str>) -> Result<ResolvedModel, ModelError> {
        let (provider_family, wire_api, model) = self
            .selections
            .lock()
            .expect("selections")
            .pop_front()
            .expect("recorded selection");
        Ok(ResolvedModel {
            provider: self.provider.clone(),
            model: model.to_owned(),
            profile_id: profile_id.unwrap_or("stable_profile").to_owned(),
            provider_family: provider_family.to_owned(),
            wire_api: wire_api.to_owned(),
            display_name: "Stable profile".to_owned(),
            capabilities: ModelCapabilities::new(200_000, true, true, true, true, true),
        })
    }
}

#[tokio::test]
async fn editing_one_profile_to_a_different_model_or_wire_is_a_model_switch() {
    let mut core = Core::new();
    let CoreEventKind::ThreadStarted { thread_id } = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread")
        .kind
    else {
        panic!("thread event");
    };
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = Arc::new(SwitchingProvider {
        requests: requests.clone(),
    });
    let resolver = Arc::new(ReconfiguredProfileResolver {
        provider,
        selections: Mutex::new(VecDeque::from([
            ("openai", "openaiResponses", "fixture-responses_before"),
            ("anthropic", "anthropicMessages", "fixture-anthropic_after"),
        ])),
    });
    let (mut runtime, mut events) =
        CoreRuntime::new_with_model_resolver(core, resolver, None, None, None);

    let TurnStartOutcome::Accepted { turn_id: first } = runtime
        .start_text_turn_with_model(
            CoreRequestId::new(2),
            thread_id.clone(),
            Some("Before profile edit".to_owned()),
            Some("stable_profile".to_owned()),
        )
        .expect("first turn")
    else {
        panic!("asynchronous turn");
    };
    wait_for_completed(&mut events, &first).await;
    let TurnStartOutcome::Accepted { turn_id: second } = runtime
        .start_text_turn_with_model(
            CoreRequestId::new(3),
            thread_id,
            Some("After profile edit".to_owned()),
            Some("stable_profile".to_owned()),
        )
        .expect("second turn")
    else {
        panic!("asynchronous turn");
    };
    wait_for_completed(&mut events, &second).await;

    let requests = requests.lock().expect("requests");
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[1]
            .instructions
            .iter()
            .filter(|instruction| {
                instruction.source == ModelInstructionSource::SugarCodeModelSwitchV1
            })
            .count(),
        1,
    );
    assert!(!requests[1].messages.iter().any(|message| {
        message
            .content
            .iter()
            .any(|part| matches!(part, ModelContentPart::ProviderContext(_)))
    }));
}

fn content_asset(kind: CoreContentAssetKind) -> CoreContentAsset {
    CoreContentAsset {
        asset_id: "ast_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .to_string(),
        sha256: "a".repeat(64),
        media_type: match kind {
            CoreContentAssetKind::Image => "image/png".to_string(),
            CoreContentAssetKind::Document => "application/pdf".to_string(),
        },
        original_name: match kind {
            CoreContentAssetKind::Image => "diagram.png".to_string(),
            CoreContentAssetKind::Document => "spec.pdf".to_string(),
        },
        size_bytes: 4096,
    }
}

enum CoreContentAssetKind {
    Image,
    Document,
}

#[test]
fn historical_unsupported_media_is_described_but_current_media_is_rejected() {
    let capabilities = ModelCapabilities::new(128_000, true, true, true, false, false);
    for part in [
        CoreUserContentPart::Image {
            asset: content_asset(CoreContentAssetKind::Image),
        },
        CoreUserContentPart::Document {
            asset: content_asset(CoreContentAssetKind::Document),
        },
    ] {
        let message = PreparedMessage::UserContent {
            content: vec![part.clone()],
        };
        let (adapted, downgraded) = prepared_model_message(&message, None, capabilities, true)
            .expect("historical media descriptor");
        assert!(downgraded);
        assert!(matches!(
            &adapted.content[0],
            ModelContentPart::Text { text, .. }
                if text.contains("Historical")
                    && text.contains("sizeBytes=4096")
                    && text.contains(&"a".repeat(64))
        ));

        let error = prepared_model_message(&message, None, capabilities, false)
            .expect_err("current unsupported media");
        assert_eq!(error.kind(), ModelErrorKind::InvalidRequest);
    }
}
