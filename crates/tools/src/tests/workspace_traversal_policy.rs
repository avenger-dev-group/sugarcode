use super::*;

#[test]
fn skips_dependency_generated_cache_and_runtime_directories() {
    for (parent, name) in [
        ("", ".git"),
        ("", "node_modules"),
        ("", "vendor"),
        ("", "coverage"),
        ("bootstrap", "cache"),
        ("storage", "framework"),
        ("storage", "logs"),
    ] {
        assert!(
            is_recursive_noise_directory(parent, name),
            "{parent}/{name}"
        );
    }
    assert!(!is_recursive_noise_directory("src", "cache"));
    assert!(!is_recursive_noise_directory("storage", "app"));
}

#[test]
fn skips_transient_generated_and_editor_files_during_search() {
    for name in [
        "debug.log",
        "bundle.min.js",
        "bundle.js.map",
        "draft.tmp",
        "source.rs.bak",
        ".handler.ts.swp",
        "notes.txt~",
    ] {
        assert!(is_transient_search_file(name), "{name}");
    }
    assert!(!is_transient_search_file("src/main.ts"));
    assert!(!is_transient_search_file("Cargo.lock"));
}
