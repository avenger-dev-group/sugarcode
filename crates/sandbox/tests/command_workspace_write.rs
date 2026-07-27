use sugarcode_sandbox::CommandSandboxAdapter;
use sugarcode_sandbox::CommandSandboxPolicy;

const ROLE_ENV: &str = "SUGARCODE_COMMAND_WORKSPACE_WRITE_TEST_ROLE";
#[cfg(target_os = "linux")]
const WORKSPACE_ENV: &str = "SUGARCODE_COMMAND_WORKSPACE_WRITE_TEST_WORKSPACE";
#[cfg(target_os = "linux")]
const REPLACEMENT_ENV: &str = "SUGARCODE_COMMAND_WORKSPACE_WRITE_TEST_REPLACEMENT";
#[cfg(target_os = "linux")]
const OUTSIDE_ENV: &str = "SUGARCODE_COMMAND_WORKSPACE_WRITE_TEST_OUTSIDE";

#[test]
fn command_workspace_write_v1_is_capability_bound_and_fail_closed() {
    if std::env::var_os(ROLE_ENV).is_some() {
        run_target();
        return;
    }

    #[cfg(target_os = "linux")]
    run_linux_matrix();

    #[cfg(not(target_os = "linux"))]
    {
        let error = CommandSandboxAdapter::probe(
            CommandSandboxPolicy::FILESYSTEM_READ_ONLY_COMMAND_WORKSPACE_WRITE_NETWORK_DENIED_V1,
        )
        .expect_err("commandWorkspaceWriteV1 must fail closed outside Linux");
        assert_eq!(
            error.kind(),
            sugarcode_sandbox::SandboxErrorKind::Unavailable
        );
    }
}

#[cfg(target_os = "linux")]
fn run_linux_matrix() {
    use std::ffi::OsString;
    use std::io::Read;
    use std::os::unix::fs::PermissionsExt;
    use sugarcode_sandbox::CommandSpec;
    use sugarcode_sandbox::CommandWorkingDirectory;

    let parent = tempfile::tempdir().expect("workspace parent");
    let configured_workspace = parent.path().join("workspace");
    let bound_workspace = parent.path().join("bound-workspace");
    let replacement = parent.path().join("replacement");
    let outside = tempfile::tempdir().expect("outside");
    std::fs::create_dir(&configured_workspace).expect("create configured workspace");
    std::fs::create_dir(&replacement).expect("create replacement");
    prepare_workspace(&configured_workspace);
    prepare_workspace(&replacement);
    prepare_outside(outside.path());
    let same_filesystem_probe = configured_workspace.join("same-filesystem-hard-link");
    std::fs::hard_link(outside.path().join("outside.txt"), &same_filesystem_probe)
        .expect("prove cross-boundary fixtures share one filesystem");
    std::fs::remove_file(same_filesystem_probe).expect("remove same-filesystem probe");
    set_user_xattr(&outside.path().join("outside.txt"), b"probe")
        .expect("prove fixture filesystem supports user xattrs");
    remove_user_xattr(&outside.path().join("outside.txt")).expect("remove fixture xattr probe");
    std::os::unix::fs::symlink(
        outside.path().join("outside.txt"),
        configured_workspace.join("outside-link"),
    )
    .expect("create outside symlink fixture");

    let directory = std::fs::File::open(&configured_workspace).expect("open workspace capability");
    std::fs::rename(&configured_workspace, &bound_workspace).expect("move bound workspace");
    std::os::unix::fs::symlink(&replacement, &configured_workspace)
        .expect("replace configured path");

    let adapter = CommandSandboxAdapter::probe(
        CommandSandboxPolicy::FILESYSTEM_READ_ONLY_COMMAND_WORKSPACE_WRITE_NETWORK_DENIED_V1,
    )
    .expect("probe command workspace-write sandbox");
    let path_authority_error = match adapter.spawn(CommandSpec {
        command: std::env::current_exe()
            .expect("test executable")
            .to_string_lossy()
            .into_owned(),
        arguments: Vec::new(),
        working_directory: CommandWorkingDirectory::from_path(configured_workspace.clone()),
        environment: Vec::new(),
    }) {
        Ok(_) => panic!("path-backed workspace authority must be rejected"),
        Err(error) => error,
    };
    assert!(matches!(
        path_authority_error,
        sugarcode_sandbox::SandboxSpawnError::Process(error)
            if error.kind() == std::io::ErrorKind::InvalidInput
    ));
    let environment = vec![
        (OsString::from(ROLE_ENV), OsString::from("target")),
        (
            OsString::from(WORKSPACE_ENV),
            configured_workspace.as_os_str().to_owned(),
        ),
        (
            OsString::from(REPLACEMENT_ENV),
            replacement.as_os_str().to_owned(),
        ),
        (
            OsString::from(OUTSIDE_ENV),
            outside.path().as_os_str().to_owned(),
        ),
        (OsString::from("LANG"), OsString::from("C")),
        (OsString::from("LC_ALL"), OsString::from("C")),
    ];
    let mut child = adapter
        .spawn(CommandSpec {
            command: std::env::current_exe()
                .expect("test executable")
                .to_string_lossy()
                .into_owned(),
            arguments: vec![
                "--exact".to_owned(),
                "command_workspace_write_v1_is_capability_bound_and_fail_closed".to_owned(),
                "--nocapture".to_owned(),
            ],
            working_directory: CommandWorkingDirectory::from_directory(directory)
                .expect("capability-backed working directory"),
            environment,
        })
        .expect("spawn command workspace-write target");
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
    assert!(
        status.success(),
        "workspace-write target failed: stdout={stdout} stderr={stderr}"
    );
    assert!(stdout.contains("workspace-write-ok"), "{stdout}");

    assert_eq!(
        std::fs::read_to_string(bound_workspace.join("target.txt")).expect("bound target"),
        "changed"
    );
    assert!(bound_workspace.join("created.txt").is_file());
    assert!(bound_workspace.join("created-dir").is_dir());
    assert!(bound_workspace.join("renamed.txt").is_file());
    assert!(bound_workspace.join("hard-link.txt").is_file());
    assert!(bound_workspace.join("created-link").is_symlink());
    assert!(!bound_workspace.join("delete-me.txt").exists());
    assert!(bound_workspace.join("nested.txt").is_file());

    assert_workspace_unchanged(&replacement);
    assert_eq!(
        std::fs::read_to_string(outside.path().join("outside.txt")).expect("outside target"),
        "outside"
    );
    assert!(outside.path().join("outside-delete.txt").is_file());
    assert!(!outside.path().join("outside-created.txt").exists());
    assert!(!outside.path().join("outside-created-dir").exists());
    assert!(!bound_workspace.join("outside-hard-link.txt").exists());
    assert!(outside.path().join("outside-rename.txt").is_file());
    assert_eq!(
        std::fs::metadata(bound_workspace.join("target.txt"))
            .expect("bound target metadata")
            .permissions()
            .mode()
            & 0o777,
        0o644
    );
    assert_eq!(
        std::fs::metadata(outside.path().join("outside.txt"))
            .expect("outside target metadata")
            .permissions()
            .mode()
            & 0o777,
        0o644
    );
}

#[cfg(target_os = "linux")]
fn prepare_workspace(root: &std::path::Path) {
    for (name, value) in [
        ("target.txt", "original"),
        ("rename-me.txt", "rename"),
        ("delete-me.txt", "delete"),
    ] {
        std::fs::write(root.join(name), value).expect("write workspace fixture");
    }
}

#[cfg(target_os = "linux")]
fn prepare_outside(root: &std::path::Path) {
    for (name, value) in [
        ("outside.txt", "outside"),
        ("outside-delete.txt", "delete"),
        ("outside-rename.txt", "rename"),
    ] {
        std::fs::write(root.join(name), value).expect("write outside fixture");
    }
}

#[cfg(target_os = "linux")]
fn assert_workspace_unchanged(root: &std::path::Path) {
    assert_eq!(
        std::fs::read_to_string(root.join("target.txt")).expect("replacement target"),
        "original"
    );
    assert!(root.join("rename-me.txt").is_file());
    assert!(root.join("delete-me.txt").is_file());
    assert!(!root.join("created.txt").exists());
}

fn run_target() {
    #[cfg(target_os = "linux")]
    match std::env::var(ROLE_ENV).expect("target role").as_str() {
        "target" => run_linux_target(),
        "nested" => {
            std::fs::write("nested.txt", "nested").expect("nested workspace write");
            assert_denied(
                "nested network bind",
                std::net::TcpListener::bind(("127.0.0.1", 0)).map(drop),
            );
        }
        role => panic!("unexpected role {role}"),
    }
}

#[cfg(target_os = "linux")]
fn run_linux_target() {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    let configured_workspace = required_path(WORKSPACE_ENV);
    let replacement = required_path(REPLACEMENT_ENV);
    let outside = required_path(OUTSIDE_ENV);
    assert_eq!(
        std::fs::read_to_string("target.txt").expect("read bound target"),
        "original"
    );

    std::fs::write("target.txt", "changed").expect("overwrite inside workspace");
    std::fs::OpenOptions::new()
        .append(true)
        .open("target.txt")
        .expect("open inside append")
        .write_all(b"-appended")
        .expect("append inside workspace");
    std::fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open("target.txt")
        .expect("truncate inside target")
        .write_all(b"changed")
        .expect("rewrite truncated target");
    std::fs::write("created.txt", "created").expect("create inside file");
    std::fs::create_dir("created-dir").expect("create inside directory");
    std::fs::rename("rename-me.txt", "renamed.txt").expect("rename inside workspace");
    std::fs::hard_link("target.txt", "hard-link.txt").expect("hard-link inside workspace");
    std::os::unix::fs::symlink("target.txt", "created-link").expect("symlink inside workspace");
    std::fs::remove_file("delete-me.txt").expect("delete inside workspace");

    let nested = Command::new(std::env::current_exe().expect("nested executable"))
        .args([
            "--exact",
            "command_workspace_write_v1_is_capability_bound_and_fail_closed",
            "--nocapture",
        ])
        .env(ROLE_ENV, "nested")
        .env(WORKSPACE_ENV, &configured_workspace)
        .env(REPLACEMENT_ENV, &replacement)
        .env(OUTSIDE_ENV, &outside)
        .status()
        .expect("spawn nested target");
    assert!(nested.success(), "nested target must inherit sandbox");

    assert_denied(
        "write configured replacement path",
        std::fs::write(configured_workspace.join("target.txt"), "redirected"),
    );
    assert_denied(
        "write replacement path",
        std::fs::write(replacement.join("target.txt"), "replacement"),
    );
    assert_denied(
        "overwrite outside",
        std::fs::write(outside.join("outside.txt"), "changed"),
    );
    assert_denied(
        "create outside",
        std::fs::write(outside.join("outside-created.txt"), "created"),
    );
    assert_denied(
        "delete outside",
        std::fs::remove_file(outside.join("outside-delete.txt")),
    );
    assert_denied(
        "mkdir outside",
        std::fs::create_dir(outside.join("outside-created-dir")),
    );
    assert_refer_denied(
        "hard-link across boundary",
        std::fs::hard_link(outside.join("outside.txt"), "outside-hard-link.txt"),
    );
    assert_refer_denied(
        "rename across boundary",
        std::fs::rename(outside.join("outside-rename.txt"), "outside-renamed.txt"),
    );
    assert_denied(
        "write through symlink to outside",
        std::fs::write("outside-link", "changed"),
    );
    assert_denied(
        "chmod inside workspace",
        std::fs::set_permissions("target.txt", std::fs::Permissions::from_mode(0o600)),
    );
    assert_denied(
        "chmod outside workspace",
        std::fs::set_permissions(
            outside.join("outside.txt"),
            std::fs::Permissions::from_mode(0o600),
        ),
    );
    assert_denied(
        "chown inside workspace",
        chown_unchanged(std::path::Path::new("target.txt")),
    );
    assert_denied(
        "chown outside workspace",
        chown_unchanged(&outside.join("outside.txt")),
    );
    assert_denied(
        "set xattr inside workspace",
        set_user_xattr(std::path::Path::new("target.txt"), b"inside"),
    );
    assert_denied(
        "set xattr outside workspace",
        set_user_xattr(&outside.join("outside.txt"), b"outside"),
    );
    assert_denied(
        "set timestamp inside workspace",
        set_timestamp(std::path::Path::new("target.txt")),
    );
    assert_denied(
        "set timestamp outside workspace",
        set_timestamp(&outside.join("outside.txt")),
    );
    assert_denied(
        "network bind",
        std::net::TcpListener::bind(("127.0.0.1", 0)).map(drop),
    );
    println!("workspace-write-ok");
}

#[cfg(target_os = "linux")]
fn required_path(name: &str) -> std::path::PathBuf {
    std::env::var_os(name)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| panic!("missing {name}"))
}

#[cfg(target_os = "linux")]
fn assert_denied(operation: &str, result: std::io::Result<impl Sized>) {
    let error = match result {
        Ok(_) => panic!("{operation} must be denied"),
        Err(error) => error,
    };
    assert_eq!(
        error.kind(),
        std::io::ErrorKind::PermissionDenied,
        "{operation}: {error}"
    );
}

#[cfg(target_os = "linux")]
fn assert_refer_denied(operation: &str, result: std::io::Result<impl Sized>) {
    let error = match result {
        Ok(_) => panic!("{operation} must be denied"),
        Err(error) => error,
    };
    assert!(
        matches!(
            error.kind(),
            std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::CrossesDevices
        ),
        "{operation}: {error}"
    );
}

#[cfg(target_os = "linux")]
fn set_user_xattr(path: &std::path::Path, value: &[u8]) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;

    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let name = c"user.sugarcode-command-test";
    let result = unsafe {
        libc::setxattr(
            path.as_ptr(),
            name.as_ptr(),
            value.as_ptr().cast(),
            value.len(),
            0,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn remove_user_xattr(path: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;

    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let result =
        unsafe { libc::removexattr(path.as_ptr(), c"user.sugarcode-command-test".as_ptr()) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn chown_unchanged(path: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;

    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let result = unsafe { libc::chown(path.as_ptr(), u32::MAX, u32::MAX) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn set_timestamp(path: &std::path::Path) -> std::io::Result<()> {
    let file = std::fs::File::open(path)?;
    file.set_times(
        std::fs::FileTimes::new()
            .set_accessed(std::time::UNIX_EPOCH)
            .set_modified(std::time::UNIX_EPOCH),
    )
}
