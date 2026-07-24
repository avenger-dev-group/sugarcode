use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;
use sugarcode_state::HomeError;
use sugarcode_state::HomeResolutionInputs;
use sugarcode_state::HomeSource;
use sugarcode_state::resolve_sugarcode_home;
use tempfile::tempdir;

#[test]
fn cli_override_wins_over_environment_and_default() {
    let cli = tempdir().expect("CLI home");
    let environment = tempdir().expect("environment home");
    let default = tempdir().expect("default home");

    let resolved = resolve_sugarcode_home(HomeResolutionInputs {
        cli_override: Some(cli.path().to_path_buf()),
        environment_override: Some(environment.path().as_os_str().to_os_string()),
        user_home: Some(default.path().to_path_buf()),
    })
    .expect("resolve CLI home");

    assert_eq!(resolved.source(), HomeSource::Cli);
    assert_eq!(
        resolved.path(),
        cli.path().canonicalize().expect("canonical CLI home")
    );
}

#[test]
fn environment_override_wins_and_empty_environment_uses_default() {
    let environment = tempdir().expect("environment home");
    let user = tempdir().expect("user home");

    let resolved = resolve_sugarcode_home(HomeResolutionInputs {
        environment_override: Some(environment.path().as_os_str().to_os_string()),
        user_home: Some(user.path().to_path_buf()),
        ..Default::default()
    })
    .expect("resolve environment home");
    assert_eq!(resolved.source(), HomeSource::Environment);

    let default = resolve_sugarcode_home(HomeResolutionInputs {
        environment_override: Some(OsString::new()),
        user_home: Some(user.path().to_path_buf()),
        ..Default::default()
    })
    .expect("resolve default home");
    assert_eq!(default.source(), HomeSource::Default);
    assert_eq!(default.path(), user.path().join(".sugarcode"));
    assert!(!default.path().exists());
}

#[test]
fn explicit_home_must_be_absolute_existing_directory() {
    let relative = resolve_sugarcode_home(HomeResolutionInputs {
        cli_override: Some(PathBuf::from("relative")),
        ..Default::default()
    })
    .expect_err("relative home must fail");
    assert!(matches!(
        relative,
        HomeError::NotAbsolute {
            source: HomeSource::Cli
        }
    ));

    let root = tempdir().expect("root");
    let missing = resolve_sugarcode_home(HomeResolutionInputs {
        environment_override: Some(root.path().join("missing").into_os_string()),
        ..Default::default()
    })
    .expect_err("missing home must fail");
    assert!(matches!(
        missing,
        HomeError::Missing {
            source: HomeSource::Environment
        }
    ));

    let file = root.path().join("file");
    fs::write(&file, "not a directory").expect("write file");
    let not_directory = resolve_sugarcode_home(HomeResolutionInputs {
        cli_override: Some(file),
        ..Default::default()
    })
    .expect_err("file home must fail");
    assert!(matches!(
        not_directory,
        HomeError::NotDirectory {
            source: HomeSource::Cli
        }
    ));
}

#[cfg(unix)]
#[test]
fn directory_symlink_is_canonicalized_and_dangling_symlink_fails() {
    use std::os::unix::fs::symlink;

    let root = tempdir().expect("root");
    let target = root.path().join("target");
    fs::create_dir(&target).expect("create target");
    let link = root.path().join("link");
    symlink(&target, &link).expect("create directory symlink");

    let resolved = resolve_sugarcode_home(HomeResolutionInputs {
        cli_override: Some(link),
        ..Default::default()
    })
    .expect("resolve symlink");
    assert_eq!(
        resolved.path(),
        target.canonicalize().expect("canonical target")
    );

    let dangling = root.path().join("dangling");
    symlink(root.path().join("missing"), &dangling).expect("create dangling symlink");
    assert!(
        resolve_sugarcode_home(HomeResolutionInputs {
            cli_override: Some(dangling),
            ..Default::default()
        })
        .is_err()
    );
}
