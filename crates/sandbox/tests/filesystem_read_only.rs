use std::ffi::OsString;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

use sugarcode_sandbox::CommandSpec;
use sugarcode_sandbox::SandboxAdapter;
use sugarcode_sandbox::SandboxPolicy;

const TEST_ROOT: &str = "SUGARCODE_SANDBOX_TEST_ROOT";
const ADAPTER_CHILD: &str = "SUGARCODE_SANDBOX_ADAPTER_CHILD";
const PAYLOAD_CHILD: &str = "SUGARCODE_SANDBOX_PAYLOAD_CHILD";
const NESTED_CHILD: &str = "SUGARCODE_SANDBOX_NESTED_CHILD";

#[test]
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
fn filesystem_read_only_v1_denies_writes_and_allows_reads() {
    let root = tempfile::tempdir().expect("create sandbox fixture root");
    prepare_fixtures(root.path());
    let output = Command::new(std::env::current_exe().expect("resolve test executable"))
        .args(["--exact", "sandbox_adapter_child", "--nocapture"])
        .env(TEST_ROOT, root.path())
        .env(ADAPTER_CHILD, "1")
        .output()
        .expect("launch sandbox adapter test child");
    assert!(
        output.status.success(),
        "adapter child failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("target.txt")).expect("read target"),
        "original"
    );
    assert!(root.path().join("readable.txt").exists());
    assert!(root.path().join("delete-me.txt").exists());
    assert!(root.path().join("rename-me.txt").exists());
    assert!(!root.path().join("created.txt").exists());
    assert!(!root.path().join("created-dir").exists());
    assert!(!root.path().join("renamed.txt").exists());
    assert!(!root.path().join("hard-link.txt").exists());
    assert!(!root.path().join("nested.txt").exists());
}

#[test]
fn sandbox_adapter_child() {
    if std::env::var_os(ADAPTER_CHILD).is_none() {
        return;
    }
    let root = required_root();
    let adapter = SandboxAdapter::probe(SandboxPolicy::FilesystemReadOnlyV1)
        .expect("filesystemReadOnlyV1 must be available");
    let mut child = adapter
        .spawn(CommandSpec {
            command: std::env::current_exe()
                .expect("resolve payload executable")
                .to_string_lossy()
                .into_owned(),
            arguments: vec![
                "--exact".to_owned(),
                "sandbox_payload_child".to_owned(),
                "--nocapture".to_owned(),
            ],
            working_directory: sugarcode_sandbox::CommandWorkingDirectory::from_path(root.clone()),
            environment: sandbox_environment(&root, PAYLOAD_CHILD),
        })
        .expect("spawn sandboxed payload");
    let mut stdout = String::new();
    child
        .take_stdout()
        .expect("payload stdout")
        .read_to_string(&mut stdout)
        .expect("read payload stdout");
    let mut stderr = String::new();
    child
        .take_stderr()
        .expect("payload stderr")
        .read_to_string(&mut stderr)
        .expect("read payload stderr");
    let status = child.wait().expect("wait for sandboxed payload");
    assert!(
        status.success(),
        "payload failed: stdout={stdout} stderr={stderr}"
    );
    assert!(stdout.contains("sandbox read allowed"));
}

#[test]
fn sandbox_payload_child() {
    if std::env::var_os(PAYLOAD_CHILD).is_none() {
        return;
    }
    let root = required_root();
    assert_eq!(
        std::fs::read_to_string(root.join("readable.txt")).expect("sandbox read must succeed"),
        "readable"
    );
    assert!(
        std::fs::read_dir(&root).is_ok(),
        "directory read must succeed"
    );
    println!("sandbox read allowed");

    assert_denied(
        "overwrite existing file",
        std::fs::write(root.join("target.txt"), "changed"),
    );
    assert_denied(
        "create file",
        std::fs::write(root.join("created.txt"), "created"),
    );
    assert_denied(
        "delete file",
        std::fs::remove_file(root.join("delete-me.txt")),
    );
    assert_denied(
        "create directory",
        std::fs::create_dir(root.join("created-dir")),
    );
    assert_denied(
        "rename file",
        std::fs::rename(root.join("rename-me.txt"), root.join("renamed.txt")),
    );
    assert_denied(
        "create hard link",
        std::fs::hard_link(root.join("target.txt"), root.join("hard-link.txt")),
    );

    let status = Command::new(std::env::current_exe().expect("resolve nested executable"))
        .args(["--exact", "sandbox_nested_child", "--nocapture"])
        .env(TEST_ROOT, &root)
        .env(NESTED_CHILD, "1")
        .status()
        .expect("spawn nested sandbox child");
    assert!(
        status.success(),
        "nested sandbox child must stay restricted"
    );
}

#[test]
fn sandbox_nested_child() {
    if std::env::var_os(NESTED_CHILD).is_none() {
        return;
    }
    assert_denied(
        "nested child create file",
        std::fs::write(required_root().join("nested.txt"), "nested"),
    );
}

fn prepare_fixtures(root: &Path) {
    for (name, value) in [
        ("readable.txt", "readable"),
        ("target.txt", "original"),
        ("delete-me.txt", "delete"),
        ("rename-me.txt", "rename"),
    ] {
        std::fs::write(root.join(name), value).expect("write sandbox fixture");
    }
}

fn required_root() -> PathBuf {
    std::env::var_os(TEST_ROOT)
        .map(PathBuf::from)
        .expect("sandbox test root")
}

fn assert_denied(operation: &str, result: std::io::Result<impl Sized>) {
    let error = match result {
        Ok(_) => panic!("{operation} must be denied"),
        Err(error) => error,
    };
    assert_eq!(
        error.kind(),
        std::io::ErrorKind::PermissionDenied,
        "{operation} must fail with PermissionDenied"
    );
}

fn sandbox_environment(root: &Path, marker: &str) -> Vec<(OsString, OsString)> {
    let mut environment = vec![
        (OsString::from(TEST_ROOT), root.as_os_str().to_owned()),
        (OsString::from(marker), OsString::from("1")),
    ];
    #[cfg(unix)]
    environment.extend([
        (OsString::from("LANG"), OsString::from("C")),
        (OsString::from("LC_ALL"), OsString::from("C")),
    ]);
    #[cfg(windows)]
    environment.extend(
        ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"]
            .into_iter()
            .filter_map(|name| std::env::var_os(name).map(|value| (OsString::from(name), value))),
    );
    environment
}
