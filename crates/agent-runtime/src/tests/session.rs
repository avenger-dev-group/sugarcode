use crate::AgentSurfaceSession;
use crate::LocalModelResolver;
use sugarcode_core::Core;
use sugarcode_core::ModelResolver;
use sugarcode_core::TurnStartOutcome;
use sugarcode_protocol::CoreEventKind;
use sugarcode_state::HomeResolutionInputs;
use sugarcode_state::ModelCapabilityMode;
use sugarcode_state::ModelCatalog;
use sugarcode_state::ModelConnection;
use sugarcode_state::ModelProfile;
use sugarcode_state::ModelProfileCapabilities;
use sugarcode_state::ModelProviderFamily;
use sugarcode_state::ModelWireApi;
use url::Url;

#[test]
fn surface_session_owns_request_correlation_and_durable_thread_operations() {
    let mut session = AgentSurfaceSession::new(Core::new());
    let started = session.start_thread().expect("start thread");
    assert_eq!(started.request_id.get(), 1);
    let thread_id = match started.kind {
        CoreEventKind::ThreadStarted { thread_id } => thread_id,
        kind => panic!("unexpected start event: {kind:?}"),
    };

    let (request_id, outcome) = session
        .start_text_turn(thread_id.clone(), Some("hello".to_string()))
        .expect("start turn");
    assert_eq!(request_id.get(), 2);
    let TurnStartOutcome::Immediate(events) = outcome else {
        panic!("memory core must complete immediately");
    };
    assert_eq!(events.len(), 5);
    assert!(events.iter().all(|event| event.request_id == request_id));

    let resumed = session.resume_thread(&thread_id).expect("resume thread");
    assert_eq!(resumed.id, thread_id);
    assert_eq!(resumed.turns.len(), 1);
}

#[test]
fn local_model_resolver_honors_default_explicit_context_and_disabled_connections() {
    let directory = tempfile::tempdir().expect("home");
    let home = sugarcode_state::resolve_sugarcode_home(HomeResolutionInputs {
        cli_override: Some(directory.path().to_path_buf()),
        ..Default::default()
    })
    .expect("resolve home");
    let connections = vec![
        ModelConnection::new(
            "conn_enabled".to_owned(),
            ModelProviderFamily::OpenAi,
            "Enabled".to_owned(),
            Url::parse("http://127.0.0.1:18080/v1").expect("URL"),
            true,
            ModelWireApi::OpenAiChatCompletions,
            None,
        )
        .expect("enabled connection"),
        ModelConnection::new(
            "conn_disabled".to_owned(),
            ModelProviderFamily::OpenAi,
            "Disabled".to_owned(),
            Url::parse("http://127.0.0.1:18081/v1").expect("URL"),
            false,
            ModelWireApi::OpenAiChatCompletions,
            None,
        )
        .expect("disabled connection"),
    ];
    let profiles = vec![
        ModelProfile::new(
            "model_default".to_owned(),
            "conn_enabled".to_owned(),
            "Default".to_owned(),
            "default-id".to_owned(),
            None,
            ModelProfileCapabilities::default(),
        )
        .expect("default profile"),
        ModelProfile::new(
            "model_custom".to_owned(),
            "conn_enabled".to_owned(),
            "Custom".to_owned(),
            "custom-id".to_owned(),
            Some(200_000),
            ModelProfileCapabilities::new(
                ModelCapabilityMode::Enabled,
                ModelCapabilityMode::Enabled,
                ModelCapabilityMode::Enabled,
                ModelCapabilityMode::Enabled,
                ModelCapabilityMode::Disabled,
            ),
        )
        .expect("custom profile"),
        ModelProfile::new(
            "model_disabled".to_owned(),
            "conn_disabled".to_owned(),
            "Unavailable".to_owned(),
            "disabled-id".to_owned(),
            None,
            ModelProfileCapabilities::default(),
        )
        .expect("disabled profile"),
    ];
    sugarcode_state::save_model_catalog(
        &home,
        &ModelCatalog::new("model_default".to_owned(), connections, profiles).expect("catalog"),
    )
    .expect("save catalog");
    let resolver = LocalModelResolver { home };

    let default = resolver.resolve(None).expect("default model");
    assert_eq!(default.profile_id, "model_default");
    assert_eq!(default.capabilities.context_window_tokens, 131_072);
    assert!(default.capabilities.tool_calls);
    assert!(!default.capabilities.strict_tool_schema);
    assert!(!default.capabilities.parallel_tool_calls);
    assert!(!default.capabilities.image_input);
    assert!(!default.capabilities.pdf_input);

    let custom = resolver
        .resolve(Some("model_custom"))
        .expect("explicit model");
    assert_eq!(custom.model, "custom-id");
    assert_eq!(custom.capabilities.context_window_tokens, 200_000);
    assert!(custom.capabilities.strict_tool_schema);
    assert!(custom.capabilities.parallel_tool_calls);

    assert!(resolver.resolve(Some("model_disabled")).is_err());
    assert!(resolver.resolve(Some("model_missing")).is_err());
}
