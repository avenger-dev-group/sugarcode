use std::ffi::OsString;
use std::io::Read;
use std::path::PathBuf;
use std::process::Command;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::time::Duration;

use sugarcode_sandbox::CommandSandboxAdapter;
use sugarcode_sandbox::CommandSandboxPolicy;
use sugarcode_sandbox::CommandSpec;

const ROLE_ENV: &str = "SUGARCODE_SANDBOX_NETWORK_TEST_ROLE";
const OPERATION_ENV: &str = "SUGARCODE_SANDBOX_NETWORK_TEST_OPERATION";
const ARGUMENT_ENV: &str = "SUGARCODE_SANDBOX_NETWORK_TEST_ARGUMENT";

#[test]
fn network_denied_v1_enforces_the_native_boundary() {
    if std::env::var_os(ROLE_ENV).is_some() {
        run_child_role();
        return;
    }

    #[cfg(windows)]
    {
        let error = CommandSandboxAdapter::probe(
            CommandSandboxPolicy::FILESYSTEM_READ_ONLY_NETWORK_DENIED_V1,
        )
        .expect_err("networkDeniedV1 must fail closed on Windows");
        assert_eq!(
            error.kind(),
            sugarcode_sandbox::SandboxErrorKind::Unavailable
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    run_supported_platform_matrix();
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn run_supported_platform_matrix() {
    let workspace = tempfile::tempdir().expect("workspace");
    let readable = workspace.path().join("readable.txt");
    let writable = workspace.path().join("writable.txt");
    std::fs::write(&readable, "read-ok").expect("read fixture");
    std::fs::write(&writable, "original").expect("write fixture");

    assert_contains(
        run_through_adapter("read-file", Some(readable.as_os_str().to_owned())),
        "allowed:read-ok",
    );
    assert_contains(
        run_through_adapter("write-file", Some(writable.as_os_str().to_owned())),
        "denied",
    );
    assert_eq!(
        std::fs::read_to_string(&writable).expect("unchanged write fixture"),
        "original"
    );

    assert_contains(run_through_adapter("socketpair", None), "allowed");
    assert_contains(run_through_adapter("tcp-bind", None), "denied");
    assert_contains(run_through_adapter("udp-bind", None), "denied");

    let tcp_v4 = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("IPv4 TCP fixture");
    tcp_v4
        .set_nonblocking(true)
        .expect("nonblocking TCP fixture");
    let tcp_v4_address = tcp_v4.local_addr().expect("IPv4 TCP fixture address");
    assert_contains(
        run_through_adapter("tcp-connect", Some(tcp_v4_address.to_string().into())),
        "denied",
    );
    assert!(matches!(
        tcp_v4.accept(),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
    ));

    if let Ok(tcp_v6) = std::net::TcpListener::bind(("::1", 0)) {
        tcp_v6
            .set_nonblocking(true)
            .expect("nonblocking IPv6 fixture");
        let tcp_v6_address = tcp_v6.local_addr().expect("IPv6 TCP fixture address");
        assert_contains(
            run_through_adapter("tcp-connect", Some(tcp_v6_address.to_string().into())),
            "denied",
        );
        assert!(matches!(
            tcp_v6.accept(),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
        ));
    }

    let udp = std::net::UdpSocket::bind(("127.0.0.1", 0)).expect("UDP fixture");
    udp.set_read_timeout(Some(Duration::from_millis(100)))
        .expect("UDP fixture timeout");
    let udp_address = udp.local_addr().expect("UDP fixture address");
    assert_contains(
        run_through_adapter("udp-send", Some(udp_address.to_string().into())),
        "denied",
    );
    let mut packet = [0u8; 64];
    assert!(matches!(
        udp.recv_from(&mut packet),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            )
    ));

    let unix_path = workspace.path().join("fixture.sock");
    let _unix_listener =
        std::os::unix::net::UnixListener::bind(&unix_path).expect("Unix socket fixture");
    assert_contains(
        run_through_adapter("unix-connect", Some(unix_path.into_os_string())),
        "denied",
    );

    use std::os::fd::AsRawFd;
    let inherited_listener =
        std::net::TcpListener::bind(("127.0.0.1", 0)).expect("inherited TCP fixture");
    let inherited_descriptor = inherited_listener.as_raw_fd();
    let current_flags = unsafe { libc::fcntl(inherited_descriptor, libc::F_GETFD) };
    assert_ne!(current_flags, -1, "read inherited descriptor flags");
    assert_ne!(
        unsafe { libc::fcntl(inherited_descriptor, libc::F_SETFD, 0) },
        -1,
        "make inherited descriptor visible to the adapter parent"
    );
    assert_contains(
        run_through_adapter(
            "accept-inherited",
            Some(inherited_descriptor.to_string().into()),
        ),
        "denied",
    );
    assert_ne!(
        unsafe { libc::fcntl(inherited_descriptor, libc::F_SETFD, current_flags) },
        -1,
        "restore inherited descriptor flags"
    );

    assert_contains(run_through_adapter("nested", None), "descendant-denied");
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn run_through_adapter(operation: &str, argument: Option<OsString>) -> String {
    let mut command = Command::new(std::env::current_exe().expect("test executable"));
    command
        .args([
            "--exact",
            "network_denied_v1_enforces_the_native_boundary",
            "--nocapture",
        ])
        .env(ROLE_ENV, "adapter")
        .env(OPERATION_ENV, operation);
    if let Some(argument) = argument {
        command.env(ARGUMENT_ENV, argument);
    }
    let output = command.output().expect("launch adapter test role");
    assert!(
        output.status.success(),
        "adapter test role failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn run_child_role() {
    match std::env::var(ROLE_ENV).expect("child role").as_str() {
        "adapter" => run_adapter_role(),
        "target" => run_target_role(),
        role => panic!("unexpected child role {role}"),
    }
}

fn run_adapter_role() {
    let executable = std::env::current_exe().expect("test executable");
    let operation = std::env::var(OPERATION_ENV).expect("test operation");
    let mut environment = vec![
        (OsString::from(ROLE_ENV), OsString::from("target")),
        (OsString::from(OPERATION_ENV), OsString::from(&operation)),
    ];
    if let Some(argument) = std::env::var_os(ARGUMENT_ENV) {
        environment.push((OsString::from(ARGUMENT_ENV), argument));
    }
    let adapter =
        CommandSandboxAdapter::probe(CommandSandboxPolicy::FILESYSTEM_READ_ONLY_NETWORK_DENIED_V1)
            .expect("probe command sandbox");
    let mut child = adapter
        .spawn(CommandSpec {
            command: executable.to_string_lossy().into_owned(),
            arguments: vec![
                "--exact".to_owned(),
                "network_denied_v1_enforces_the_native_boundary".to_owned(),
                "--nocapture".to_owned(),
            ],
            working_directory: sugarcode_sandbox::CommandWorkingDirectory::from_path(
                std::env::current_dir().expect("current directory"),
            ),
            environment,
        })
        .expect("spawn sandbox target");
    let mut stdout = String::new();
    child
        .take_stdout()
        .expect("target stdout")
        .read_to_string(&mut stdout)
        .expect("read target stdout");
    let mut stderr = String::new();
    child
        .take_stderr()
        .expect("target stderr")
        .read_to_string(&mut stderr)
        .expect("read target stderr");
    let status = child.wait().expect("wait for target");
    assert!(status.success(), "target failed: {stderr}");
    print!("{stdout}");
}

fn run_target_role() {
    let operation = std::env::var(OPERATION_ENV).expect("target operation");
    match operation.as_str() {
        "read-file" => match std::fs::read_to_string(argument_path()) {
            Ok(content) => println!("allowed:{content}"),
            Err(error) => println!("denied:{error}"),
        },
        "write-file" => print_result(std::fs::write(argument_path(), "changed")),
        "socketpair" => {
            #[cfg(unix)]
            {
                let mut descriptors = [-1; 2];
                let result = unsafe {
                    libc::socketpair(
                        libc::AF_UNIX,
                        libc::SOCK_STREAM,
                        0,
                        descriptors.as_mut_ptr(),
                    )
                };
                if result == 0 {
                    unsafe {
                        libc::close(descriptors[0]);
                        libc::close(descriptors[1]);
                    }
                    println!("allowed");
                } else {
                    println!("denied:{}", std::io::Error::last_os_error());
                }
            }
        }
        "tcp-bind" => print_result(std::net::TcpListener::bind(("127.0.0.1", 0)).map(drop)),
        "udp-bind" => print_result(std::net::UdpSocket::bind(("127.0.0.1", 0)).map(drop)),
        "tcp-connect" => {
            let address = std::env::var(ARGUMENT_ENV).expect("TCP address");
            print_result(std::net::TcpStream::connect(address).map(drop));
        }
        "udp-send" => {
            let address = std::env::var(ARGUMENT_ENV).expect("UDP address");
            let result = std::net::UdpSocket::bind(("0.0.0.0", 0))
                .and_then(|socket| socket.send_to(&[0x12, 0x34, 0x01, 0x00], address))
                .map(drop);
            print_result(result);
        }
        "unix-connect" => {
            #[cfg(unix)]
            print_result(std::os::unix::net::UnixStream::connect(argument_path()).map(drop));
        }
        "accept-inherited" => {
            #[cfg(unix)]
            {
                let descriptor = std::env::var(ARGUMENT_ENV)
                    .expect("inherited descriptor")
                    .parse::<i32>()
                    .expect("descriptor number");
                let result =
                    unsafe { libc::accept(descriptor, std::ptr::null_mut(), std::ptr::null_mut()) };
                if result == -1 {
                    println!("denied:{}", std::io::Error::last_os_error());
                } else {
                    unsafe {
                        libc::close(result);
                    }
                    println!("allowed");
                }
            }
        }
        "nested" => {
            let output = Command::new(std::env::current_exe().expect("test executable"))
                .args([
                    "--exact",
                    "network_denied_v1_enforces_the_native_boundary",
                    "--nocapture",
                ])
                .env(ROLE_ENV, "target")
                .env(OPERATION_ENV, "tcp-bind")
                .output()
                .expect("spawn descendant");
            if output.status.success() && String::from_utf8_lossy(&output.stdout).contains("denied")
            {
                println!("descendant-denied");
            } else {
                println!("descendant-allowed");
            }
        }
        operation => panic!("unexpected target operation {operation}"),
    }
}

fn argument_path() -> PathBuf {
    PathBuf::from(std::env::var_os(ARGUMENT_ENV).expect("path argument"))
}

fn print_result<T>(result: std::io::Result<T>) {
    match result {
        Ok(_) => println!("allowed"),
        Err(error) => println!("denied:{error}"),
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn assert_contains(output: String, expected: &str) {
    assert!(
        output.contains(expected),
        "expected {expected:?} in adapter output: {output}"
    );
}
