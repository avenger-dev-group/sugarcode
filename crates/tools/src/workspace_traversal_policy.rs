pub(crate) fn is_recursive_noise_directory(parent: &str, name: &str) -> bool {
    matches!(
        name,
        ".cache"
            | ".git"
            | ".hg"
            | ".next"
            | ".nuxt"
            | ".svn"
            | ".svelte-kit"
            | ".turbo"
            | "__pycache__"
            | "build"
            | "coverage"
            | "dist"
            | "logs"
            | "node_modules"
            | "out"
            | "target"
            | "temp"
            | "tmp"
            | "vendor"
    ) || matches!(
        (parent, name),
        ("bootstrap", "cache") | ("public", "build") | ("storage", "framework" | "logs")
    )
}

pub(crate) fn is_transient_search_file(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    normalized.ends_with('~')
        || [
            ".bak", ".log", ".map", ".old", ".orig", ".pyc", ".pyo", ".rej", ".swo", ".swp",
            ".temp", ".tmp",
        ]
        .iter()
        .any(|suffix| normalized.ends_with(suffix))
        || normalized.contains(".min.")
}

#[cfg(test)]
#[path = "tests/workspace_traversal_policy.rs"]
mod tests;
