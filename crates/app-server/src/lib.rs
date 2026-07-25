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
use sugarcode_model_provider::OpenAiChatCompletionsProvider;
use sugarcode_state::EffectiveConfig;
use sugarcode_state::ModelApiFormat;
use sugarcode_state::RolloutRepository;

pub async fn run_stdio(config: EffectiveConfig) -> io::Result<()> {
    let model = config.model().cloned();
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
    let (runtime, events) = match model {
        Some(model) => {
            let provider: Arc<dyn sugarcode_model_provider::ModelProvider> =
                match model.api_format() {
                    ModelApiFormat::OpenAiChatCompletions => Arc::new(
                        OpenAiChatCompletionsProvider::new_secret(
                            model.endpoint().clone(),
                            model.token().map(sugarcode_state::ModelToken::clone_secret),
                        )
                        .map_err(io::Error::other)?,
                    ),
                };
            CoreRuntime::new(core, provider, model.model().to_string())
        }
        None => CoreRuntime::without_model(core),
    };
    let session = Session::with_core(runtime);
    let input = tokio::io::BufReader::new(tokio::io::stdin());
    let output = tokio::io::BufWriter::new(tokio::io::stdout());
    serve_with_events(input, output, session, events).await
}

pub fn generate_typescript(out_dir: &std::path::Path) -> io::Result<()> {
    sugarcode_app_server_protocol::generate_typescript(out_dir)
}

pub fn generate_json_schema(out_dir: &std::path::Path) -> io::Result<()> {
    sugarcode_app_server_protocol::generate_json_schema(out_dir)
}
