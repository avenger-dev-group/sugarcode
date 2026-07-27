use crate::workspace_capability::WorkspaceReadErrorKind;
use crate::workspace_capability::map_io_error;
use crate::workspace_capability::open_directory_component;
use crate::workspace_instructions::WorkspaceInstructionsErrorKind;
use crate::workspace_list::cap_metadata_is_reparse_point;
use crate::workspace_snapshot::StableUtf8FileErrorKind;
use crate::workspace_snapshot::read_stable_utf8_file;
use cap_std::fs::Dir;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;

pub const MAX_WORKSPACE_SKILL_BYTES: usize = 32 * 1024;
pub const MAX_WORKSPACE_SKILL_SNAPSHOT_BYTES: usize = 1024 * 1024;
pub const MAX_WORKSPACE_SKILL_COUNT: usize = 64;
pub const MAX_WORKSPACE_SKILL_INVENTORY_BYTES: usize = 96 * 1024;
pub const MAX_SELECTED_WORKSPACE_SKILLS: usize = 4;
pub const MAX_SELECTED_WORKSPACE_SKILL_BYTES: usize = 128 * 1024;
const MAX_WORKSPACE_SKILL_ROOT_ENTRIES: usize = 256;
const MAX_WORKSPACE_SKILL_DIRECTORY_ENTRIES: usize = 1024;
const MAX_WORKSPACE_SKILL_FRONTMATTER_BYTES: usize = 8 * 1024;
const MAX_WORKSPACE_SKILL_NAME_BYTES: usize = 64;
const MAX_WORKSPACE_SKILL_DESCRIPTION_BYTES: usize = 1024;
const WORKSPACE_SKILLS_MANIFEST_DOMAIN: &[u8] = b"boundedLocalWorkspaceSkillsV1\0";
const WORKSPACE_SKILLS_SELECTION_DOMAIN: &[u8] = b"boundedLocalWorkspaceSkillsV1/selection\0";
const AGENTS_DIRECTORY_NAME: &str = ".agents";
const SKILLS_DIRECTORY_NAME: &str = "skills";
const SKILL_FILE_NAME: &str = "SKILL.md";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceSkillsErrorKind {
    AccessDenied,
    PathNotAllowed,
    NotDirectory,
    HardLinkNotAllowed,
    FileTooLarge,
    InvalidEncoding,
    InvalidFrontmatter,
    InvalidName,
    InvalidDescription,
    TooManyEntries,
    TooManySkills,
    AggregateTooLarge,
    InventoryTooLarge,
    ChangedDuringDiscovery,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceScopeContextErrorKind {
    Scope(WorkspaceReadErrorKind),
    Instructions(WorkspaceInstructionsErrorKind),
    Skills(WorkspaceSkillsErrorKind),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceSkillSelectionErrorKind {
    TooManySkills,
    AggregateTooLarge,
}

#[derive(Clone, PartialEq, Eq)]
struct WorkspaceSkill {
    name: String,
    description: String,
    content: String,
    bytes: usize,
    sha256: String,
}

impl std::fmt::Debug for WorkspaceSkill {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkspaceSkill")
            .field("name", &"<redacted>")
            .field("description", &"<redacted>")
            .field("content", &"<redacted>")
            .field("bytes", &self.bytes)
            .field("sha256", &self.sha256)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct WorkspaceSkillsSnapshot {
    skills: Vec<WorkspaceSkill>,
    inventory: String,
    discovered_count: usize,
    source_bytes: usize,
    manifest_sha256: String,
}

impl std::fmt::Debug for WorkspaceSkillsSnapshot {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkspaceSkillsSnapshot")
            .field("effective_count", &self.skills.len())
            .field("discovered_count", &self.discovered_count)
            .field("source_bytes", &self.source_bytes)
            .field("inventory_bytes", &self.inventory.len())
            .field("manifest_sha256", &self.manifest_sha256)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct WorkspaceSkillSelection {
    pub content: Option<String>,
    pub selected_count: usize,
    pub selected_bytes: usize,
    pub sha256: Option<String>,
}

impl std::fmt::Debug for WorkspaceSkillSelection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkspaceSkillSelection")
            .field("content", &self.content.as_ref().map(|_| "<redacted>"))
            .field("selected_count", &self.selected_count)
            .field("selected_bytes", &self.selected_bytes)
            .field("sha256", &self.sha256)
            .finish()
    }
}

impl WorkspaceSkillsSnapshot {
    pub fn inventory(&self) -> &str {
        &self.inventory
    }

    pub fn discovered_count(&self) -> usize {
        self.discovered_count
    }

    pub fn effective_count(&self) -> usize {
        self.skills.len()
    }

    pub fn source_bytes(&self) -> usize {
        self.source_bytes
    }

    pub fn manifest_sha256(&self) -> &str {
        &self.manifest_sha256
    }

    pub fn select(
        &self,
        input: Option<&str>,
    ) -> Result<WorkspaceSkillSelection, WorkspaceSkillSelectionErrorKind> {
        let Some(input) = input else {
            return Ok(empty_selection());
        };
        let skills = self
            .skills
            .iter()
            .map(|skill| (skill.name.as_str(), skill))
            .collect::<BTreeMap<_, _>>();
        let mut selected_names = BTreeSet::new();
        let mut selected = Vec::new();
        for (index, _) in input.match_indices('$') {
            let suffix = &input[index + 1..];
            let name_bytes = suffix
                .as_bytes()
                .iter()
                .take_while(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || **byte == b'-'
                })
                .count();
            if name_bytes == 0 {
                continue;
            }
            let name = &suffix[..name_bytes];
            let Some(skill) = skills.get(name).copied() else {
                continue;
            };
            if selected_names.insert(name) {
                if selected.len() >= MAX_SELECTED_WORKSPACE_SKILLS {
                    return Err(WorkspaceSkillSelectionErrorKind::TooManySkills);
                }
                selected.push(skill);
            }
        }
        if selected.is_empty() {
            return Ok(empty_selection());
        }

        let mut selected_bytes = 0usize;
        let mut content = String::new();
        let mut digest = Sha256::new();
        digest.update(WORKSPACE_SKILLS_SELECTION_DOMAIN);
        digest.update((selected.len() as u64).to_be_bytes());
        for skill in selected {
            selected_bytes = selected_bytes
                .checked_add(skill.bytes)
                .filter(|bytes| *bytes <= MAX_SELECTED_WORKSPACE_SKILL_BYTES)
                .ok_or(WorkspaceSkillSelectionErrorKind::AggregateTooLarge)?;
            digest.update((skill.name.len() as u64).to_be_bytes());
            digest.update(skill.name.as_bytes());
            digest.update((skill.sha256.len() as u64).to_be_bytes());
            digest.update(skill.sha256.as_bytes());
            if !content.is_empty() {
                content.push_str("\n\n");
            }
            content.push_str("--- Selected Skill: $");
            content.push_str(&skill.name);
            content.push_str(" ---\n");
            content.push_str(&skill.content);
        }
        Ok(WorkspaceSkillSelection {
            content: Some(content),
            selected_count: selected_names.len(),
            selected_bytes,
            sha256: Some(format!("{:x}", digest.finalize())),
        })
    }
}

pub(crate) fn load_workspace_skills(
    directories: &[Dir],
    components: &[PathBuf],
) -> Result<WorkspaceSkillsSnapshot, WorkspaceSkillsErrorKind> {
    let scope_paths = scope_paths(components);
    let mut manifest = Sha256::new();
    manifest.update(WORKSPACE_SKILLS_MANIFEST_DOMAIN);
    manifest.update((directories.len() as u64).to_be_bytes());
    let mut discovered = Vec::new();
    let mut source_bytes = 0usize;
    let mut root_entries = 0usize;
    let mut skill_directory_entries = 0usize;

    for (depth, (directory, scope_path)) in directories.iter().zip(scope_paths.iter()).enumerate() {
        manifest.update((scope_path.len() as u64).to_be_bytes());
        manifest.update(scope_path.as_bytes());
        let agents = match open_directory_component(directory, Path::new(AGENTS_DIRECTORY_NAME)) {
            Ok(directory) => directory,
            Err(WorkspaceReadErrorKind::NotFound) => {
                manifest.update([0]);
                continue;
            }
            Err(kind) => return Err(map_workspace_error(kind)),
        };
        let skills_root = match open_directory_component(&agents, Path::new(SKILLS_DIRECTORY_NAME))
        {
            Ok(directory) => directory,
            Err(WorkspaceReadErrorKind::NotFound) => {
                manifest.update([1, 0]);
                continue;
            }
            Err(kind) => return Err(map_workspace_error(kind)),
        };
        manifest.update([1, 1]);
        let mut entries = collect_names(
            &skills_root,
            &mut root_entries,
            MAX_WORKSPACE_SKILL_ROOT_ENTRIES,
        )?;
        entries.sort_unstable_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
        manifest.update((entries.len() as u64).to_be_bytes());
        for name in entries {
            manifest.update((name.len() as u64).to_be_bytes());
            manifest.update(name.as_bytes());
            let metadata = skills_root
                .symlink_metadata(&name)
                .map_err(|error| map_workspace_error(map_io_error(&error)))?;
            let file_type = metadata.file_type();
            let linked = file_type.is_symlink() || cap_metadata_is_reparse_point(&metadata);
            manifest.update([u8::from(linked), u8::from(file_type.is_dir())]);
            if !valid_skill_name(&name) {
                continue;
            }
            if linked {
                return Err(WorkspaceSkillsErrorKind::PathNotAllowed);
            }
            if !file_type.is_dir() {
                continue;
            }
            let skill_directory = open_directory_component(&skills_root, Path::new(&name))
                .map_err(map_workspace_error)?;
            let child_names = collect_names(
                &skill_directory,
                &mut skill_directory_entries,
                MAX_WORKSPACE_SKILL_DIRECTORY_ENTRIES,
            )?;
            if !child_names.iter().any(|child| child == SKILL_FILE_NAME) {
                manifest.update([0]);
                continue;
            }
            manifest.update([1]);
            let file = read_stable_utf8_file(
                &skill_directory,
                Path::new(SKILL_FILE_NAME),
                MAX_WORKSPACE_SKILL_BYTES,
            )
            .map_err(map_stable_file_error)?;
            let (parsed_name, description) = parse_frontmatter(&file.content)?;
            if parsed_name != name {
                return Err(WorkspaceSkillsErrorKind::InvalidName);
            }
            if discovered.len() >= MAX_WORKSPACE_SKILL_COUNT {
                return Err(WorkspaceSkillsErrorKind::TooManySkills);
            }
            source_bytes = source_bytes
                .checked_add(file.bytes)
                .filter(|bytes| *bytes <= MAX_WORKSPACE_SKILL_SNAPSHOT_BYTES)
                .ok_or(WorkspaceSkillsErrorKind::AggregateTooLarge)?;
            manifest.update((parsed_name.len() as u64).to_be_bytes());
            manifest.update(parsed_name.as_bytes());
            manifest.update((description.len() as u64).to_be_bytes());
            manifest.update(description.as_bytes());
            manifest.update((file.bytes as u64).to_be_bytes());
            manifest.update(file.sha256.as_bytes());
            discovered.push((
                depth,
                WorkspaceSkill {
                    name: parsed_name,
                    description,
                    content: file.content,
                    bytes: file.bytes,
                    sha256: file.sha256,
                },
            ));
        }
    }

    let discovered_count = discovered.len();
    let mut effective = BTreeMap::new();
    for (depth, skill) in discovered {
        effective.insert(skill.name.clone(), (depth, skill));
    }
    let skills = effective
        .into_values()
        .map(|(_, skill)| skill)
        .collect::<Vec<_>>();
    let mut inventory = String::new();
    for skill in &skills {
        let description = serde_json::to_string(&skill.description)
            .map_err(|_| WorkspaceSkillsErrorKind::Unavailable)?;
        inventory.push_str("- $");
        inventory.push_str(&skill.name);
        inventory.push_str(": ");
        inventory.push_str(&description);
        inventory.push('\n');
        if inventory.len() > MAX_WORKSPACE_SKILL_INVENTORY_BYTES {
            return Err(WorkspaceSkillsErrorKind::InventoryTooLarge);
        }
    }
    Ok(WorkspaceSkillsSnapshot {
        skills,
        inventory,
        discovered_count,
        source_bytes,
        manifest_sha256: format!("{:x}", manifest.finalize()),
    })
}

fn collect_names(
    directory: &Dir,
    observed: &mut usize,
    limit: usize,
) -> Result<Vec<String>, WorkspaceSkillsErrorKind> {
    let mut names = Vec::new();
    let mut entries = directory
        .entries()
        .map_err(|error| map_workspace_error(map_io_error(&error)))?;
    for entry in &mut entries {
        *observed = observed
            .checked_add(1)
            .filter(|count| *count <= limit)
            .ok_or(WorkspaceSkillsErrorKind::TooManyEntries)?;
        let entry = entry.map_err(|error| map_workspace_error(map_io_error(&error)))?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| WorkspaceSkillsErrorKind::InvalidEncoding)?;
        if name.is_empty() || name.chars().any(char::is_control) {
            return Err(WorkspaceSkillsErrorKind::InvalidName);
        }
        names.push(name);
    }
    Ok(names)
}

fn parse_frontmatter(content: &str) -> Result<(String, String), WorkspaceSkillsErrorKind> {
    let normalized = content.replace("\r\n", "\n");
    let Some(remainder) = normalized.strip_prefix("---\n") else {
        return Err(WorkspaceSkillsErrorKind::InvalidFrontmatter);
    };
    let Some(closing) = remainder.find("\n---\n") else {
        return Err(WorkspaceSkillsErrorKind::InvalidFrontmatter);
    };
    if closing > MAX_WORKSPACE_SKILL_FRONTMATTER_BYTES {
        return Err(WorkspaceSkillsErrorKind::InvalidFrontmatter);
    }
    let frontmatter = &remainder[..closing];
    let body = &remainder[closing + "\n---\n".len()..];
    if body.trim().is_empty() {
        return Err(WorkspaceSkillsErrorKind::InvalidFrontmatter);
    }
    let mut name = None;
    let mut description = None;
    for line in frontmatter.lines() {
        let Some((key, value)) = line.split_once(':') else {
            return Err(WorkspaceSkillsErrorKind::InvalidFrontmatter);
        };
        let value = parse_scalar(value.trim())?;
        match key.trim() {
            "name" if name.is_none() => name = Some(value),
            "description" if description.is_none() => description = Some(value),
            "name" | "description" => {
                return Err(WorkspaceSkillsErrorKind::InvalidFrontmatter);
            }
            _ => {}
        }
    }
    let name = name.ok_or(WorkspaceSkillsErrorKind::InvalidFrontmatter)?;
    if !valid_skill_name(&name) {
        return Err(WorkspaceSkillsErrorKind::InvalidName);
    }
    let description = description.ok_or(WorkspaceSkillsErrorKind::InvalidFrontmatter)?;
    if description.is_empty()
        || description.len() > MAX_WORKSPACE_SKILL_DESCRIPTION_BYTES
        || description.chars().any(char::is_control)
    {
        return Err(WorkspaceSkillsErrorKind::InvalidDescription);
    }
    Ok((name, description))
}

fn parse_scalar(value: &str) -> Result<String, WorkspaceSkillsErrorKind> {
    if value.starts_with('"') {
        serde_json::from_str(value).map_err(|_| WorkspaceSkillsErrorKind::InvalidFrontmatter)
    } else if value.is_empty() || value.starts_with(['\'', '[', '{', '|', '>']) {
        Err(WorkspaceSkillsErrorKind::InvalidFrontmatter)
    } else {
        Ok(value.to_string())
    }
}

fn valid_skill_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_WORKSPACE_SKILL_NAME_BYTES
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && name
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && name
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
}

fn scope_paths(components: &[PathBuf]) -> Vec<String> {
    let mut paths = Vec::with_capacity(components.len() + 1);
    paths.push(String::new());
    let mut current = String::new();
    for component in components {
        if !current.is_empty() {
            current.push('/');
        }
        current.push_str(
            component
                .to_str()
                .expect("validated workspace component is UTF-8"),
        );
        paths.push(current.clone());
    }
    paths
}

fn empty_selection() -> WorkspaceSkillSelection {
    WorkspaceSkillSelection {
        content: None,
        selected_count: 0,
        selected_bytes: 0,
        sha256: None,
    }
}

fn map_workspace_error(kind: WorkspaceReadErrorKind) -> WorkspaceSkillsErrorKind {
    match kind {
        WorkspaceReadErrorKind::AccessDenied => WorkspaceSkillsErrorKind::AccessDenied,
        WorkspaceReadErrorKind::PathNotAllowed => WorkspaceSkillsErrorKind::PathNotAllowed,
        WorkspaceReadErrorKind::NotRegularFile => WorkspaceSkillsErrorKind::NotDirectory,
        WorkspaceReadErrorKind::FileTooLarge => WorkspaceSkillsErrorKind::FileTooLarge,
        WorkspaceReadErrorKind::BinaryFile => WorkspaceSkillsErrorKind::InvalidEncoding,
        WorkspaceReadErrorKind::ChangedDuringRead => {
            WorkspaceSkillsErrorKind::ChangedDuringDiscovery
        }
        WorkspaceReadErrorKind::InvalidPath
        | WorkspaceReadErrorKind::NotFound
        | WorkspaceReadErrorKind::Cancelled
        | WorkspaceReadErrorKind::Unavailable => WorkspaceSkillsErrorKind::Unavailable,
    }
}

fn map_stable_file_error(kind: StableUtf8FileErrorKind) -> WorkspaceSkillsErrorKind {
    match kind {
        StableUtf8FileErrorKind::Read(kind) => map_workspace_error(kind),
        StableUtf8FileErrorKind::HardLinkNotAllowed => WorkspaceSkillsErrorKind::HardLinkNotAllowed,
        StableUtf8FileErrorKind::FileTooLarge => WorkspaceSkillsErrorKind::FileTooLarge,
        StableUtf8FileErrorKind::InvalidEncoding => WorkspaceSkillsErrorKind::InvalidEncoding,
        StableUtf8FileErrorKind::ChangedDuringRead => {
            WorkspaceSkillsErrorKind::ChangedDuringDiscovery
        }
    }
}

#[cfg(test)]
#[path = "tests/workspace_skills.rs"]
mod tests;
