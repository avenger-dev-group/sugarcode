use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;
use std::path::PathBuf;

#[test]
fn generated_artifacts_match_committed_files() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let generated_ts = temp.path().join("typescript");
    let generated_schema = temp.path().join("schema");
    sugarcode_app_server_protocol::generate_typescript(&generated_ts).expect("generate TypeScript");
    sugarcode_app_server_protocol::generate_json_schema(&generated_schema)
        .expect("generate JSON Schema");

    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    assert_trees_equal(
        &repo_root.join("packages/app-server-protocol/src/generated"),
        &generated_ts,
    );
    assert_trees_equal(
        &repo_root.join("packages/app-server-protocol/schema"),
        &generated_schema,
    );
}

fn assert_trees_equal(expected_root: &Path, actual_root: &Path) {
    let expected = collect_files(expected_root).expect("read committed artifacts");
    let actual = collect_files(actual_root).expect("read generated artifacts");
    assert_eq!(
        expected, actual,
        "generated protocol artifacts drifted; regenerate them with the sugarcode CLI"
    );
}

fn collect_files(root: &Path) -> io::Result<BTreeMap<PathBuf, Vec<u8>>> {
    let mut files = BTreeMap::new();
    collect_files_at(root, root, &mut files)?;
    Ok(files)
}

fn collect_files_at(
    root: &Path,
    current: &Path,
    files: &mut BTreeMap<PathBuf, Vec<u8>>,
) -> io::Result<()> {
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_files_at(root, &path, files)?;
        } else if path.is_file() {
            let relative = path
                .strip_prefix(root)
                .expect("child path has root prefix")
                .to_path_buf();
            files.insert(relative, fs::read(path)?);
        }
    }
    Ok(())
}
