use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use sugarcode_tools::{
    MAX_WORKSPACE_SKILL_BYTES, MAX_WORKSPACE_SKILL_COUNT, MAX_WORKSPACE_SKILL_SNAPSHOT_BYTES,
    parse_workspace_skill_definition,
};

const MAX_ROOT_ENTRIES: usize = 256;
const MAX_IMPORT_FILES: usize = 512;
const MAX_IMPORT_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillEntry {
    id: String,
    name: String,
    description: String,
    source: &'static str,
    path: String,
    sha256: String,
    bytes: usize,
    enabled: bool,
    #[serde(skip_serializing)]
    source_directory: PathBuf,
    #[serde(skip_serializing)]
    content: String,
}

pub(super) fn inspect_skills_json(
    user_root: &Path,
    workspace_root: Option<&Path>,
    preferences: &HashMap<String, bool>,
) -> Result<String, String> {
    let skills = discover(user_root, workspace_root, preferences)?;
    serde_json::to_string(&json!({
        "skills": skills,
        "workspaceAvailable": workspace_root.is_some(),
    }))
    .map_err(|error| error.to_string())
}

pub(super) fn skills_context_json(
    user_root: &Path,
    workspace_root: Option<&Path>,
    preferences: &HashMap<String, bool>,
) -> Result<String, String> {
    let mut context_bytes = 0usize;
    let skills = discover(user_root, workspace_root, preferences)?
        .into_iter()
        .filter(|skill| skill.enabled)
        .map(|skill| {
            context_bytes = context_bytes
                .checked_add(skill.bytes)
                .ok_or_else(|| "Enabled Skills exceed the bounded context.".to_owned())?;
            if context_bytes > MAX_WORKSPACE_SKILL_SNAPSHOT_BYTES {
                return Err("Enabled Skills exceed the bounded context.".to_owned());
            }
            Ok(json!({
                "name": skill.name,
                "description": skill.description,
                "content": skill.content,
                "bytes": skill.bytes,
                "sha256": skill.sha256,
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    serde_json::to_string(&json!({ "skills": skills })).map_err(|error| error.to_string())
}

pub(super) fn read_skill_content_json(
    user_root: &Path,
    workspace_root: Option<&Path>,
    preferences: &HashMap<String, bool>,
    skill_id: &str,
    expected_sha256: &str,
) -> Result<String, String> {
    let skill = require_skill(user_root, workspace_root, preferences, skill_id)?;
    if skill.sha256 != expected_sha256 {
        return Err("Skill changed after the inventory was loaded.".to_owned());
    }
    serde_json::to_string(&json!({ "skill": skill, "content": skill.content }))
        .map_err(|error| error.to_string())
}

fn require_skill(
    user_root: &Path,
    workspace_root: Option<&Path>,
    preferences: &HashMap<String, bool>,
    skill_id: &str,
) -> Result<SkillEntry, String> {
    discover(user_root, workspace_root, preferences)?
        .into_iter()
        .find(|skill| skill.id == skill_id)
        .ok_or_else(|| "Skill is not available in the active scope.".to_owned())
}

pub(super) fn ensure_skill(
    user_root: &Path,
    workspace_root: Option<&Path>,
    preferences: &HashMap<String, bool>,
    skill_id: &str,
) -> Result<(), String> {
    require_skill(user_root, workspace_root, preferences, skill_id).map(|_| ())
}

pub(super) fn import_skill(
    user_root: &Path,
    workspace_root: Option<&Path>,
    source_path: &Path,
    scope: &str,
) -> Result<(), String> {
    let source = canonical_directory(source_path)?;
    let (_, definition, _, _) = read_definition(&source)?;
    let destination_root = match scope {
        "user" => canonical_directory(user_root)?,
        "project" => create_project_skills_root(
            workspace_root
                .ok_or_else(|| "Open a project before importing a project Skill.".to_owned())?,
        )?,
        _ => return Err("Skill import scope must be user or project.".to_owned()),
    };
    let destination = destination_root.join(&definition.name);
    if destination.exists() {
        return Err("A Skill with this name already exists in the selected scope.".to_owned());
    }
    if destination.starts_with(&source) {
        return Err("A Skill cannot be imported into its own source directory.".to_owned());
    }
    validate_copy_tree(&source)?;
    copy_tree(&source, &destination).inspect_err(|_| {
        let _ = fs::remove_dir_all(&destination);
    })
}

pub(super) fn export_skill(
    user_root: &Path,
    workspace_root: Option<&Path>,
    preferences: &HashMap<String, bool>,
    skill_id: &str,
    destination_root: &Path,
) -> Result<serde_json::Value, String> {
    let skill = require_skill(user_root, workspace_root, preferences, skill_id)?;
    let destination_root = canonical_directory(destination_root)?;
    let destination = destination_root.join(&skill.name);
    if destination.exists() {
        return Err("The export destination already contains this Skill.".to_owned());
    }
    if destination.starts_with(&skill.source_directory) {
        return Err("A Skill cannot be exported inside its own directory.".to_owned());
    }
    validate_copy_tree(&skill.source_directory)?;
    copy_tree(&skill.source_directory, &destination).inspect_err(|_| {
        let _ = fs::remove_dir_all(&destination);
    })?;
    Ok(json!({ "path": destination.to_string_lossy() }))
}

fn discover(
    user_root: &Path,
    workspace_root: Option<&Path>,
    preferences: &HashMap<String, bool>,
) -> Result<Vec<SkillEntry>, String> {
    let mut roots = vec![("user", user_root.to_path_buf(), "skills".to_owned())];
    if let Some(workspace_root) = workspace_root {
        for relative in [".sugarcode/skills", ".agents/skills", ".claude/skills"] {
            roots.push((
                "project",
                workspace_root.join(relative),
                relative.to_owned(),
            ));
        }
    }
    let mut effective = BTreeMap::<String, SkillEntry>::new();
    let mut observed = 0usize;
    for (source, root, display_root) in roots {
        if !root.exists() {
            continue;
        }
        let root = if source == "project" {
            canonical_descendant(
                &root,
                workspace_root.expect("project source has a workspace root"),
            )?
        } else {
            canonical_directory(&root)?
        };
        let mut entries = fs::read_dir(&root)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        entries.sort_by_key(|entry| entry.file_name());
        if entries.len() > MAX_ROOT_ENTRIES {
            return Err("Skill directory contains too many entries.".to_owned());
        }
        for entry in entries {
            let file_type = entry.file_type().map_err(|error| error.to_string())?;
            if !file_type.is_dir() || file_type.is_symlink() {
                continue;
            }
            let source_directory = entry.path();
            let (content, definition, bytes, sha256) = match read_definition(&source_directory) {
                Ok(value) => value,
                Err(_) => continue,
            };
            observed += 1;
            if observed > MAX_WORKSPACE_SKILL_COUNT {
                return Err("Too many Skills are available in this scope.".to_owned());
            }
            let id = skill_id(&source_directory)?;
            let folder = source_directory
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| "Skill directory name is not valid UTF-8.".to_owned())?;
            let path = format!("{display_root}/{folder}/SKILL.md");
            effective.insert(
                definition.name.clone(),
                SkillEntry {
                    enabled: preferences.get(&id).copied().unwrap_or(true),
                    id,
                    name: definition.name,
                    description: definition.description,
                    source,
                    path,
                    sha256,
                    bytes,
                    source_directory,
                    content,
                },
            );
        }
    }
    Ok(effective.into_values().collect())
}

fn read_definition(
    directory: &Path,
) -> Result<
    (
        String,
        sugarcode_tools::WorkspaceSkillDefinition,
        usize,
        String,
    ),
    String,
> {
    let path = directory.join("SKILL.md");
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("SKILL.md must be a regular file.".to_owned());
    }
    let bytes = usize::try_from(metadata.len()).map_err(|_| "SKILL.md is too large.")?;
    if bytes == 0 || bytes > MAX_WORKSPACE_SKILL_BYTES {
        return Err("SKILL.md is empty or too large.".to_owned());
    }
    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    if content.len() != bytes {
        return Err("SKILL.md changed while it was being read.".to_owned());
    }
    let definition = parse_workspace_skill_definition(&content)
        .map_err(|kind| format!("Invalid SKILL.md frontmatter: {kind:?}."))?;
    let sha256 = format!("{:x}", Sha256::digest(content.as_bytes()));
    Ok((content, definition, bytes, sha256))
}

fn skill_id(source_directory: &Path) -> Result<String, String> {
    let canonical = source_directory
        .canonicalize()
        .map_err(|error| error.to_string())?;
    Ok(format!(
        "skl_{:x}",
        Sha256::digest(canonical.to_string_lossy().as_bytes())
    ))
}

fn canonical_directory(path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Skill path must be a real directory.".to_owned());
    }
    path.canonicalize().map_err(|error| error.to_string())
}

fn canonical_descendant(path: &Path, owner: &Path) -> Result<PathBuf, String> {
    let canonical = canonical_directory(path)?;
    let owner = owner.canonicalize().map_err(|error| error.to_string())?;
    if !canonical.starts_with(&owner) {
        return Err("Project Skill directories must stay inside the project.".to_owned());
    }
    Ok(canonical)
}

fn create_project_skills_root(workspace_root: &Path) -> Result<PathBuf, String> {
    let workspace_root = workspace_root
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let sugarcode_root = workspace_root.join(".sugarcode");
    if !sugarcode_root.exists() {
        fs::create_dir(&sugarcode_root).map_err(|error| error.to_string())?;
    }
    let sugarcode_root = canonical_descendant(&sugarcode_root, &workspace_root)?;
    let skills_root = sugarcode_root.join("skills");
    if !skills_root.exists() {
        fs::create_dir(&skills_root).map_err(|error| error.to_string())?;
    }
    canonical_descendant(&skills_root, &workspace_root)
}

fn validate_copy_tree(root: &Path) -> Result<(), String> {
    let mut pending = vec![root.to_path_buf()];
    let mut files = 0usize;
    let mut bytes = 0u64;
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let file_type = entry.file_type().map_err(|error| error.to_string())?;
            if file_type.is_symlink() {
                return Err("Skill directories cannot contain symbolic links.".to_owned());
            }
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file() {
                files += 1;
                bytes = bytes
                    .checked_add(entry.metadata().map_err(|error| error.to_string())?.len())
                    .ok_or_else(|| "Skill directory is too large.".to_owned())?;
                if files > MAX_IMPORT_FILES || bytes > MAX_IMPORT_BYTES {
                    return Err("Skill directory is too large.".to_owned());
                }
            } else {
                return Err("Skill directories can contain only files and directories.".to_owned());
            }
        }
    }
    Ok(())
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir(destination).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let target = destination.join(entry.file_name());
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target).map_err(|error| error.to_string())?;
        } else {
            return Err("Skill directories cannot contain links or special files.".to_owned());
        }
    }
    Ok(())
}
