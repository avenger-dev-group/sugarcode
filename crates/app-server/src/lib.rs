mod event_mapping;
mod session;
mod stdio;

pub use session::Session;
pub use session::SessionState;
pub use stdio::serve;
pub use stdio::serve_with_events;
pub use stdio::serve_with_session;

use std::io;
use std::sync::Arc;
use sugarcode_core::Core;
use sugarcode_core::CoreRuntime;
use sugarcode_credential_store::CredentialReference;
use sugarcode_credential_store::CredentialStore;
use sugarcode_credential_store::OsCredentialStore;
use sugarcode_model_provider::OpenAiChatCompletionsProvider;
use sugarcode_state::EffectiveConfig;
use sugarcode_state::ModelApiFormat;
use sugarcode_state::RolloutRepository;
use zeroize::Zeroizing;

pub async fn run_stdio(config: EffectiveConfig) -> io::Result<()> {
    let model = config.model().cloned();
    let model_token = model
        .as_ref()
        .and_then(|model| model.credential_reference())
        .map(|reference| load_model_token(config.home().path(), reference))
        .transpose();
    let repository = RolloutRepository::open(config.home()).map_err(io::Error::other)?;
    for diagnostic in repository.diagnostics() {
        eprintln!("sugarcode: {diagnostic}");
    }
    for diagnostic in repository.projection_diagnostics() {
        eprintln!("sugarcode: {diagnostic}");
    }
    for diagnostic in repository.search_projection_diagnostics() {
        eprintln!("sugarcode: {diagnostic}");
    }
    let core = Core::with_repository(Box::new(repository));
    let (runtime, events) = match (model, model_token) {
        (Some(_), Err(_)) => {
            eprintln!("sugarcode: configured model credential is unavailable");
            CoreRuntime::without_model(core)
        }
        (Some(model), Ok(token)) => {
            let provider: Arc<dyn sugarcode_model_provider::ModelProvider> =
                match model.api_format() {
                    ModelApiFormat::OpenAiChatCompletions => Arc::new(
                        OpenAiChatCompletionsProvider::new_secret(model.endpoint().clone(), token)
                            .map_err(io::Error::other)?,
                    ),
                };
            CoreRuntime::new(core, provider, model.model().to_string())
        }
        (None, Ok(None)) => CoreRuntime::without_model(core),
        (None, Ok(Some(_))) | (None, Err(_)) => unreachable!("token lookup requires a model"),
    };
    let session = Session::with_core(runtime);
    let input = tokio::io::BufReader::new(tokio::io::stdin());
    let output = tokio::io::BufWriter::new(tokio::io::stdout());
    serve_with_events(input, output, session, events).await
}

fn load_model_token(home: &std::path::Path, reference: &str) -> io::Result<Zeroizing<String>> {
    let reference = CredentialReference::parse(reference).map_err(io::Error::other)?;
    let store = OsCredentialStore::new(home);
    let Some(secret) = store.get(&reference).map_err(io::Error::other)? else {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "configured model credential is missing",
        ));
    };
    let token = std::str::from_utf8(secret.expose())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "model credential is not UTF-8"))?;
    if token.len() > sugarcode_credential_store::MAX_SECRET_BYTES
        || !token.bytes().all(|byte| matches!(byte, 0x21..=0x7e))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "model credential is invalid",
        ));
    }
    Ok(Zeroizing::new(token.to_owned()))
}

pub fn generate_typescript(out_dir: &std::path::Path) -> io::Result<()> {
    sugarcode_app_server_protocol::generate_typescript(out_dir)
}

pub fn generate_json_schema(out_dir: &std::path::Path) -> io::Result<()> {
    sugarcode_app_server_protocol::generate_json_schema(out_dir)
}
