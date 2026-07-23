use std::process::Command;

#[test]
fn version_reports_product_and_protocol_versions() {
    let output = Command::new(env!("CARGO_BIN_EXE_sugarcode"))
        .arg("version")
        .output()
        .expect("run sugarcode version");

    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).expect("UTF-8 stdout"),
        "sugarcode 1.0.0\napp-server-protocol 1\n"
    );
    assert!(output.stderr.is_empty());
}
