use clap::Args;
use clap::Parser;
use clap::Subcommand;
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(name = "sugarcode", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Print product and app-server protocol versions.
    Version,
    /// Run the local app server or generate its public protocol artifacts.
    AppServer(AppServerArgs),
}

#[derive(Debug, Args)]
struct AppServerArgs {
    /// Serve newline-delimited JSON-RPC over stdin/stdout.
    #[arg(long)]
    stdio: bool,
    #[command(subcommand)]
    command: Option<AppServerCommand>,
}

#[derive(Debug, Subcommand)]
enum AppServerCommand {
    /// Generate TypeScript bindings from the Rust public protocol types.
    GenerateTs(OutputArgs),
    /// Generate JSON Schema from the Rust public protocol types.
    GenerateJsonSchema(OutputArgs),
}

#[derive(Debug, Args)]
struct OutputArgs {
    #[arg(long, value_name = "DIR")]
    out: PathBuf,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run(Cli::parse()).await {
        eprintln!("sugarcode: {error}");
        std::process::exit(1);
    }
}

async fn run(cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    match cli.command {
        Command::Version => {
            println!(
                "sugarcode {}",
                sugarcode_app_server_protocol::SUGARCODE_PRODUCT_VERSION
            );
            println!(
                "app-server-protocol {}",
                sugarcode_app_server_protocol::PROTOCOL_VERSION
            );
        }
        Command::AppServer(args) => match (args.stdio, args.command) {
            (true, None) => sugarcode_app_server::run_stdio().await?,
            (false, Some(AppServerCommand::GenerateTs(args))) => {
                sugarcode_app_server::generate_typescript(&args.out)?;
            }
            (false, Some(AppServerCommand::GenerateJsonSchema(args))) => {
                sugarcode_app_server::generate_json_schema(&args.out)?;
            }
            _ => {
                return Err(
                    "choose --stdio, generate-ts --out DIR, or generate-json-schema --out DIR"
                        .into(),
                );
            }
        },
    }
    Ok(())
}
