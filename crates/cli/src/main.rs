mod config;
mod credential;

use clap::Args;
use clap::Parser;
use clap::Subcommand;
use std::io::IsTerminal;
use std::path::PathBuf;
use sugarcode_credential_store::OsCredentialStore;

#[derive(Debug, Parser)]
#[command(name = "sugarcode", version)]
struct Cli {
    /// Override the SugarCode home directory.
    #[arg(long, global = true, value_name = "DIR")]
    home: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    #[command(hide = true, name = "__command-supervisor")]
    InternalSupervisor,
    #[command(hide = true, name = "__command-sandbox-probe")]
    InternalSandboxProbe,
    #[cfg(debug_assertions)]
    #[command(hide = true, name = "__command-test-tree")]
    InternalTestTree,
    #[cfg(debug_assertions)]
    #[command(hide = true, name = "__command-test-leaf")]
    InternalTestLeaf,
    /// Print product and app-server protocol versions.
    Version,
    /// Validate SugarCode's non-secret configuration.
    Config(ConfigArgs),
    /// Manage secrets in the operating-system credential store.
    Credential(CredentialArgs),
    /// Run the local app server or generate its public protocol artifacts.
    AppServer(AppServerArgs),
}

#[derive(Debug, Args)]
struct ConfigArgs {
    #[command(subcommand)]
    command: ConfigCommand,
}

#[derive(Debug, Subcommand)]
enum ConfigCommand {
    /// Validate the effective non-secret configuration.
    Validate,
    /// Manage the active text-model configuration.
    Model(ModelConfigArgs),
}

#[derive(Debug, Args)]
struct ModelConfigArgs {
    #[command(subcommand)]
    command: ModelConfigCommand,
}

#[derive(Debug, Subcommand)]
enum ModelConfigCommand {
    /// Read a complete model configuration from standard input and save it.
    Set {
        /// Require JSON configuration input on standard input.
        #[arg(long)]
        stdin: bool,
    },
    /// Print the active model configuration without its token.
    Show {
        /// Emit one JSON object.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Args)]
struct CredentialArgs {
    #[command(subcommand)]
    command: CredentialCommand,
}

#[derive(Debug, Subcommand)]
enum CredentialCommand {
    /// Read a secret from standard input and store it.
    Set {
        /// Non-secret logical credential reference.
        reference: String,
        /// Require secret input on standard input.
        #[arg(long)]
        stdin: bool,
    },
    /// Report whether a credential is present without displaying it.
    Status {
        /// Non-secret logical credential reference.
        reference: String,
    },
    /// Delete a credential if it is present.
    Delete {
        /// Non-secret logical credential reference.
        reference: String,
    },
}

#[derive(Debug, Args)]
struct AppServerArgs {
    /// Serve newline-delimited JSON-RPC over stdin/stdout.
    #[arg(long)]
    stdio: bool,
    /// Explicit workspace root available to bounded model tools.
    #[arg(long, value_name = "DIR")]
    workspace: Option<PathBuf>,
    /// Enable bounded workspace/apply-patch writes for this process only.
    #[arg(long, requires = "workspace")]
    allow_workspace_write: bool,
    /// Enable sandboxed shell-command writes inside the explicit workspace.
    #[arg(long, requires = "workspace")]
    allow_command_workspace_write: bool,
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
    let Cli { home, command } = cli;
    match command {
        Command::InternalSupervisor => {
            sugarcode_tools::run_shell_command_supervisor()
                .map_err(|error| format!("command supervisor failed: {error}"))?;
        }
        Command::InternalSandboxProbe => {
            sugarcode_tools::run_shell_command_sandbox_probe()
                .map_err(|error| format!("command sandbox probe failed: {error}"))?;
        }
        #[cfg(debug_assertions)]
        Command::InternalTestTree => {
            let mut child = std::process::Command::new(std::env::current_exe()?)
                .arg("__command-test-leaf")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::inherit())
                .stderr(std::process::Stdio::inherit())
                .spawn()?;
            child.wait()?;
        }
        #[cfg(debug_assertions)]
        Command::InternalTestLeaf => {
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
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
        Command::Config(ConfigArgs {
            command: ConfigCommand::Validate,
        }) => {
            let config = sugarcode_state::load_effective_config(home)?;
            println!(
                "SugarCode configuration is valid (schema version {}).",
                config.schema_version()
            );
        }
        Command::Config(ConfigArgs {
            command:
                ConfigCommand::Model(ModelConfigArgs {
                    command: ModelConfigCommand::Set { stdin },
                }),
        }) => {
            if !stdin || std::io::stdin().is_terminal() {
                return Err(Box::new(config::ModelConfigCommandError::StdinRequired));
            }
            let resolved_home = sugarcode_state::resolve_sugarcode_home_from_process(home)?;
            let store = OsCredentialStore::new(resolved_home.path());
            config::set_model_config(
                &resolved_home,
                &store,
                &mut std::io::stdin().lock(),
                &mut std::io::stdout().lock(),
            )?;
        }
        Command::Config(ConfigArgs {
            command:
                ConfigCommand::Model(ModelConfigArgs {
                    command: ModelConfigCommand::Show { json },
                }),
        }) => {
            if !json {
                return Err("config model show requires --json".into());
            }
            let effective_config = sugarcode_state::load_effective_config(home)?;
            config::show_model_config(&effective_config, &mut std::io::stdout().lock())?;
        }
        Command::Credential(args) => {
            let config = sugarcode_state::load_effective_config(home)?;
            let store = OsCredentialStore::new(config.home().path());
            let action = match args.command {
                CredentialCommand::Set { reference, stdin } => credential::CredentialAction::Set {
                    reference,
                    read_stdin: stdin,
                },
                CredentialCommand::Status { reference } => {
                    credential::CredentialAction::Status { reference }
                }
                CredentialCommand::Delete { reference } => {
                    credential::CredentialAction::Delete { reference }
                }
            };
            let stdin_is_terminal = std::io::stdin().is_terminal();
            credential::run_credential_action(
                action,
                &store,
                &mut std::io::stdin().lock(),
                stdin_is_terminal,
                &mut std::io::stdout().lock(),
            )?;
        }
        Command::AppServer(args) => match (
            args.stdio,
            args.command,
            args.workspace,
            args.allow_workspace_write,
            args.allow_command_workspace_write,
        ) {
            (true, None, workspace, allow_workspace_write, allow_command_workspace_write) => {
                let effective_config = sugarcode_state::load_effective_config(home)?;
                sugarcode_app_server::run_stdio(
                    effective_config,
                    workspace,
                    allow_workspace_write,
                    allow_command_workspace_write,
                )
                .await?;
            }
            (false, Some(AppServerCommand::GenerateTs(args)), None, false, false) => {
                sugarcode_app_server::generate_typescript(&args.out)?;
            }
            (false, Some(AppServerCommand::GenerateJsonSchema(args)), None, false, false) => {
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
