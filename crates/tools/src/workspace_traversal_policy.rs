pub(crate) fn is_recursive_noise_directory(parent: &str, name: &str) -> bool {
    matches!(
        name,
        ".angular"
            | ".astro"
            | ".build"
            | ".cache"
            | ".dart_tool"
            | ".docusaurus"
            | ".expo"
            | ".git"
            | ".gradle"
            | ".hg"
            | ".mypy_cache"
            | ".next"
            | ".nox"
            | ".nuxt"
            | ".nx"
            | ".nyc_output"
            | ".parcel-cache"
            | ".pnpm-store"
            | ".pytest_cache"
            | ".ruff_cache"
            | ".serverless"
            | ".svn"
            | ".svelte-kit"
            | ".terraform"
            | ".tox"
            | ".turbo"
            | ".venv"
            | ".vite"
            | ".webpack"
            | "__pycache__"
            | "bower_components"
            | "build"
            | "coverage"
            | "DerivedData"
            | "dist"
            | "logs"
            | "node_modules"
            | "out"
            | "Pods"
            | "target"
            | "temp"
            | "tmp"
            | "vendor"
    ) || matches!(
        (parent, name),
        (".yarn", "cache" | "unplugged")
            | ("bootstrap", "cache")
            | ("public", "build")
            | ("storage", "framework" | "logs")
    )
}

pub(crate) fn is_transient_search_file(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        ".coverage" | ".ds_store" | ".eslintcache" | ".stylelintcache" | "lcov.info" | "thumbs.db"
    ) || normalized.ends_with('~')
        || [
            ".bak",
            ".log",
            ".map",
            ".old",
            ".orig",
            ".pyc",
            ".pyo",
            ".rej",
            ".swo",
            ".swp",
            ".temp",
            ".tmp",
            ".tsbuildinfo",
        ]
        .iter()
        .any(|suffix| normalized.ends_with(suffix))
        || normalized.contains(".min.")
}

#[cfg(test)]
#[path = "tests/workspace_traversal_policy.rs"]
mod tests;
