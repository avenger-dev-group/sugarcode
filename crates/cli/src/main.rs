mod config;

use clap::Args;
use clap::Parser;
use clap::Subcommand;
use std::io::IsTerminal;
use std::io::Read;
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(name = "sugarcode", version)]
struct Cli {
    /// Override the SugarCode home directory.
    #[arg(long, global = true, value_name = "DIR")]
    home: Option<PathBuf>,
    #[command(flatten)]
    tui: TuiArgs,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Args)]
struct TuiArgs {
    /// Explicit workspace root available to the interactive agent.
    #[arg(long, value_name = "DIR")]
    workspace: Option<PathBuf>,
    /// Active workspace scope relative to the explicit workspace root.
    #[arg(long, value_name = "RELATIVE_DIR", requires = "workspace")]
    workspace_scope: Option<String>,
    /// Enable bounded workspace/apply-patch writes for this process only.
    #[arg(long, requires = "workspace")]
    allow_workspace_write: bool,
    /// Enable sandboxed shell-command writes inside the explicit workspace.
    #[arg(long, requires = "workspace")]
    allow_command_workspace_write: bool,
    /// Discover an explicitly configured MCP server for this session.
    #[arg(long, value_name = "ID", action = clap::ArgAction::Append)]
    mcp_server: Vec<String>,
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
    #[cfg(debug_assertions)]
    #[command(hide = true, name = "__command-workspace-write-acceptance")]
    InternalWorkspaceWriteAcceptance,
    #[command(hide = true, name = "__desktop-terminal")]
    InternalDesktopTerminal(DesktopTerminalArgs),
    /// Print product and app-server protocol versions.
    Version,
    /// Validate SugarCode's local configuration.
    Config(ConfigArgs),
    /// Run the local app server or generate its public protocol artifacts.
    AppServer(AppServerArgs),
    /// Run one non-interactive agent turn.
    Exec(ExecArgs),
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
    /// Inspect configured MCP servers without exposing launch details.
    Mcp(McpConfigArgs),
}

#[derive(Debug, Args)]
struct ModelConfigArgs {
    #[command(subcommand)]
    command: ModelConfigCommand,
}

#[derive(Debug, Subcommand)]
enum ModelConfigCommand {
    /// Delete only the locally stored model API key.
    DeleteApiKey {
        /// Emit the resulting model configuration receipt as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Inspect the saved model configuration and API-key status.
    Inspect {
        /// Emit one versioned JSON object.
        #[arg(long)]
        json: bool,
    },
    /// Validate a complete model configuration from standard input.
    Validate {
        /// Require JSON configuration input on standard input.
        #[arg(long)]
        stdin: bool,
        /// Emit one versioned JSON object.
        #[arg(long)]
        json: bool,
    },
    /// Read a complete model configuration update from standard input and save it.
    Set {
        /// Require JSON configuration input on standard input.
        #[arg(long)]
        stdin: bool,
        /// Emit one versioned JSON object.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Args)]
struct McpConfigArgs {
    #[command(subcommand)]
    command: McpConfigCommand,
}

#[derive(Debug, Subcommand)]
enum McpConfigCommand {
    /// Print the configured MCP server inventory without sensitive fields.
    List {
        /// Emit one JSON object.
        #[arg(long)]
        json: bool,
    },
    /// Inspect the complete non-secret MCP server configuration.
    Inspect {
        /// Emit one versioned JSON object.
        #[arg(long)]
        json: bool,
    },
    /// Validate a complete MCP server configuration from standard input.
    Validate {
        /// Require JSON configuration input on standard input.
        #[arg(long)]
        stdin: bool,
        /// Emit one versioned JSON object.
        #[arg(long)]
        json: bool,
    },
    /// Replace the complete MCP server configuration from standard input.
    Set {
        /// Require JSON configuration input on standard input.
        #[arg(long)]
        stdin: bool,
        /// Emit one versioned JSON object.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Args)]
struct AppServerArgs {
    /// Serve newline-delimited JSON-RPC over stdin/stdout.
    #[arg(long)]
    stdio: bool,
    /// Explicit workspace root available to bounded model tools and root AGENTS.md instructions.
    #[arg(long, value_name = "DIR")]
    workspace: Option<PathBuf>,
    /// Active workspace scope relative to the explicit workspace root.
    #[arg(long, value_name = "RELATIVE_DIR", requires = "workspace")]
    workspace_scope: Option<String>,
    /// Keep durable Threads workspace-free while exposing an isolated Desktop chat directory.
    #[arg(long, hide = true, requires = "workspace")]
    unbound_threads: bool,
    /// Enable bounded workspace/apply-patch writes for this process only.
    #[arg(long, requires = "workspace")]
    allow_workspace_write: bool,
    /// Enable sandboxed shell-command writes inside the explicit workspace.
    #[arg(long, requires = "workspace")]
    allow_command_workspace_write: bool,
    /// Discover an explicitly configured local stdio MCP server before serving (maximum 2).
    #[arg(long, value_name = "ID", action = clap::ArgAction::Append)]
    mcp_server: Vec<String>,
    #[command(subcommand)]
    command: Option<AppServerCommand>,
}

#[derive(Debug, Args)]
struct DesktopTerminalArgs {
    #[arg(long, value_name = "DIR")]
    workspace: PathBuf,
    #[arg(long, value_parser = clap::value_parser!(u16).range(2..=500))]
    columns: u16,
    #[arg(long, value_parser = clap::value_parser!(u16).range(2..=300))]
    rows: u16,
}

#[derive(Debug, Args)]
struct ExecArgs {
    /// Resume one existing active Thread instead of creating a new Thread.
    #[arg(long, value_name = "THREAD_ID")]
    resume: Option<String>,
    /// Explicit workspace root available to bounded model tools and instructions.
    #[arg(long, value_name = "DIR")]
    workspace: Option<PathBuf>,
    /// Active workspace scope relative to the explicit workspace root.
    #[arg(long, value_name = "RELATIVE_DIR", requires = "workspace")]
    workspace_scope: Option<String>,
    /// Enable bounded workspace/apply-patch writes for this process only.
    #[arg(long, requires = "workspace")]
    allow_workspace_write: bool,
    /// Enable sandboxed shell-command writes inside the explicit workspace.
    #[arg(long, requires = "workspace")]
    allow_command_workspace_write: bool,
    /// Discover one explicitly configured MCP server for this run.
    #[arg(long, value_name = "ID", action = clap::ArgAction::Append)]
    mcp_server: Vec<String>,
    /// Emit versioned JSON Lines instead of human-readable events.
    #[arg(long)]
    json: bool,
    /// One prompt. When omitted, read a bounded prompt from non-terminal stdin.
    #[arg(value_name = "PROMPT")]
    prompt: Option<String>,
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
    match run(Cli::parse()).await {
        Ok(code) if code != sugarcode_exec::EXEC_EXIT_SUCCESS => {
            std::process::exit(i32::from(code));
        }
        Ok(_) => {}
        Err(error) => {
            eprintln!("sugarcode: {error}");
            std::process::exit(1);
        }
    }
}

async fn run(cli: Cli) -> Result<u8, Box<dyn std::error::Error>> {
    let Cli { home, tui, command } = cli;
    let Some(command) = command else {
        if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
            return Err(
                "interactive TUI requires terminal stdin and stdout; use `sugarcode exec` for non-interactive input"
                    .into(),
            );
        }
        sugarcode_tui::run(sugarcode_tui::TuiRequest {
            home,
            workspace: tui.workspace,
            workspace_scope: tui.workspace_scope,
            allow_workspace_write: tui.allow_workspace_write,
            allow_command_workspace_write: tui.allow_command_workspace_write,
            mcp_servers: tui.mcp_server,
        })
        .await?;
        return Ok(sugarcode_exec::EXEC_EXIT_SUCCESS);
    };
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
        #[cfg(debug_assertions)]
        Command::InternalWorkspaceWriteAcceptance => {
            std::fs::write("updated.txt", "after\n")?;
            std::fs::write("created.txt", "created\n")?;
            std::fs::remove_file("deleted.txt")?;
            std::fs::rename("rename-source.txt", "renamed.txt")?;
            std::fs::hard_link("hardlink-source.txt", "hardlink-created.txt")?;
            #[cfg(unix)]
            std::os::unix::fs::symlink("symlink-target.txt", "symlink-created.txt")?;
            std::fs::write("binary.bin", [0_u8, 159, 146, 150, 255])?;
            println!("workspace-write-acceptance:ok");
        }
        Command::InternalDesktopTerminal(args) => {
            sugarcode_terminal::run_stdio(&args.workspace, args.columns, args.rows)?;
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
                    command: ModelConfigCommand::DeleteApiKey { json },
                }),
        }) => {
            let resolved_home = sugarcode_state::resolve_sugarcode_home_from_process(home)?;
            if json {
                config::delete_model_api_key(&resolved_home, &mut std::io::stdout().lock())?;
            } else {
                let removed = config::delete_model_api_key(&resolved_home, &mut std::io::sink())?;
                if removed {
                    println!("Model API key removed from local configuration.");
                } else {
                    println!("Model API key is not configured.");
                }
            }
        }
        Command::Config(ConfigArgs {
            command:
                ConfigCommand::Model(ModelConfigArgs {
                    command: ModelConfigCommand::Set { stdin, json },
                }),
        }) => {
            if !stdin || !json || std::io::stdin().is_terminal() {
                return Err(Box::new(config::ModelConfigCommandError::StdinRequired));
            }
            let resolved_home = sugarcode_state::resolve_sugarcode_home_from_process(home)?;
            config::set_model_config(
                &resolved_home,
                &mut std::io::stdin().lock(),
                &mut std::io::stdout().lock(),
            )?;
        }
        Command::Config(ConfigArgs {
            command:
                ConfigCommand::Model(ModelConfigArgs {
                    command: ModelConfigCommand::Inspect { json },
                }),
        }) => {
            if !json {
                return Err("config model inspect requires --json".into());
            }
            let resolved_home = sugarcode_state::resolve_sugarcode_home_from_process(home)?;
            config::inspect_model_config(&resolved_home, &mut std::io::stdout().lock())?;
        }
        Command::Config(ConfigArgs {
            command:
                ConfigCommand::Model(ModelConfigArgs {
                    command: ModelConfigCommand::Validate { stdin, json },
                }),
        }) => {
            if !stdin || !json || std::io::stdin().is_terminal() {
                return Err(Box::new(config::ModelConfigCommandError::StdinRequired));
            }
            config::validate_model_config(
                &mut std::io::stdin().lock(),
                &mut std::io::stdout().lock(),
            )?;
        }
        Command::Config(ConfigArgs {
            command:
                ConfigCommand::Mcp(McpConfigArgs {
                    command: McpConfigCommand::List { json },
                }),
        }) => {
            if !json {
                return Err("config mcp list requires --json".into());
            }
            let effective_config = sugarcode_state::load_effective_config(home)?;
            config::list_mcp_servers(&effective_config, &mut std::io::stdout().lock())?;
        }
        Command::Config(ConfigArgs {
            command:
                ConfigCommand::Mcp(McpConfigArgs {
                    command: McpConfigCommand::Inspect { json },
                }),
        }) => {
            if !json {
                return Err("config mcp inspect requires --json".into());
            }
            let resolved_home = sugarcode_state::resolve_sugarcode_home_from_process(home)?;
            config::inspect_mcp_config(&resolved_home, &mut std::io::stdout().lock())?;
        }
        Command::Config(ConfigArgs {
            command:
                ConfigCommand::Mcp(McpConfigArgs {
                    command: McpConfigCommand::Validate { stdin, json },
                }),
        }) => {
            if !stdin || !json || std::io::stdin().is_terminal() {
                return Err(Box::new(config::McpConfigCommandError::StdinRequired));
            }
            config::validate_mcp_config(
                &mut std::io::stdin().lock(),
                &mut std::io::stdout().lock(),
            )?;
        }
        Command::Config(ConfigArgs {
            command:
                ConfigCommand::Mcp(McpConfigArgs {
                    command: McpConfigCommand::Set { stdin, json },
                }),
        }) => {
            if !stdin || !json || std::io::stdin().is_terminal() {
                return Err(Box::new(config::McpConfigCommandError::StdinRequired));
            }
            let resolved_home = sugarcode_state::resolve_sugarcode_home_from_process(home)?;
            config::set_mcp_config(
                &resolved_home,
                &mut std::io::stdin().lock(),
                &mut std::io::stdout().lock(),
            )?;
        }
        Command::AppServer(args) => match (
            args.stdio,
            args.command,
            args.workspace,
            args.workspace_scope,
            args.unbound_threads,
            args.allow_workspace_write,
            args.allow_command_workspace_write,
            args.mcp_server,
        ) {
            (
                true,
                None,
                workspace,
                workspace_scope,
                unbound_threads,
                allow_workspace_write,
                allow_command_workspace_write,
                mcp_server,
            ) => {
                let effective_config = sugarcode_state::load_runtime_config(home)?;
                sugarcode_app_server::run_stdio(
                    effective_config,
                    workspace,
                    workspace_scope,
                    unbound_threads,
                    allow_workspace_write,
                    allow_command_workspace_write,
                    mcp_server,
                )
                .await?;
            }
            (
                false,
                Some(AppServerCommand::GenerateTs(args)),
                None,
                None,
                false,
                false,
                false,
                mcp_servers,
            ) if mcp_servers.is_empty() => {
                sugarcode_app_server::generate_typescript(&args.out)?;
            }
            (
                false,
                Some(AppServerCommand::GenerateJsonSchema(args)),
                None,
                None,
                false,
                false,
                false,
                mcp_servers,
            ) if mcp_servers.is_empty() => {
                sugarcode_app_server::generate_json_schema(&args.out)?;
            }
            _ => {
                return Err(
                    "choose --stdio, generate-ts --out DIR, or generate-json-schema --out DIR"
                        .into(),
                );
            }
        },
        Command::Exec(args) => {
            let prompt = match args.prompt {
                Some(prompt) => prompt,
                None if std::io::stdin().is_terminal() => String::new(),
                None => {
                    let mut prompt = String::new();
                    std::io::stdin()
                        .lock()
                        .take((sugarcode_exec::MAX_EXEC_PROMPT_BYTES + 1) as u64)
                        .read_to_string(&mut prompt)?;
                    prompt
                }
            };
            let cancellation = sugarcode_exec::termination_token();
            let exit_code = sugarcode_exec::run(
                sugarcode_exec::ExecRequest {
                    home,
                    workspace: args.workspace,
                    workspace_scope: args.workspace_scope,
                    allow_workspace_write: args.allow_workspace_write,
                    allow_command_workspace_write: args.allow_command_workspace_write,
                    mcp_servers: args.mcp_server,
                    resume_thread_id: args.resume,
                    prompt,
                    output_format: if args.json {
                        sugarcode_exec::ExecOutputFormat::JsonLines
                    } else {
                        sugarcode_exec::ExecOutputFormat::Human
                    },
                },
                &mut std::io::stdout().lock(),
                &mut std::io::stderr().lock(),
                cancellation,
            )
            .await;
            return Ok(exit_code);
        }
    }
    Ok(sugarcode_exec::EXEC_EXIT_SUCCESS)
}
