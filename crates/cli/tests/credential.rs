use std::process::Command;

#[test]
fn real_cli_composes_the_os_store_without_writing_or_exposing_a_secret() {
    let home = tempfile::tempdir().expect("isolated SugarCode home");
    let output = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .arg("--home")
        .arg(home.path())
        .args(["credential", "status", "composition-probe"])
        .env_remove("SUGARCODE_HOME")
        .output()
        .expect("run credential status");

    let stdout = String::from_utf8(output.stdout).expect("UTF-8 stdout");
    let stderr = String::from_utf8(output.stderr).expect("UTF-8 stderr");
    if output.status.success() {
        assert_eq!(stdout, "Credential is missing.\n");
        assert!(stderr.is_empty());
    } else {
        assert!(stdout.is_empty());
        assert!(
            stderr.contains("credential store backend is unavailable")
                || stderr.contains("credential store access is unavailable")
                || stderr.contains("credential store operation failed"),
            "unexpected safe diagnostic: {stderr}"
        );
    }
    assert!(!stdout.contains("secret"));
    assert!(!stderr.contains("secret"));
    assert_eq!(
        std::fs::read_dir(home.path())
            .expect("read isolated home")
            .count(),
        0,
        "credential status must not create ordinary state"
    );
}
