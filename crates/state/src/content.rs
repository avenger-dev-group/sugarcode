use sha2::Digest;
use sha2::Sha256;
use std::error::Error;
use std::fmt;
use std::fs;
use std::io;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use tempfile::NamedTempFile;

pub const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_PDF_BYTES: usize = 20 * 1024 * 1024;
pub const MAX_TEXT_BYTES: usize = 1024 * 1024;
pub const MAX_PDF_PAGES: u32 = 100;
pub const MAX_TURN_ATTACHMENTS: usize = 10;
pub const MAX_TURN_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentAssetKind {
    Image,
    Pdf,
    Text,
}

impl ContentAssetKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Pdf => "pdf",
            Self::Text => "text",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentAsset {
    pub asset_id: String,
    pub sha256: String,
    pub media_type: String,
    pub original_name: String,
    pub size_bytes: u64,
    pub kind: ContentAssetKind,
    pub pdf_pages: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct ContentStore {
    root: PathBuf,
}

impl ContentStore {
    pub fn open_at(home: &Path) -> Result<Self, ContentStoreError> {
        ensure_directory(home)?;
        let content = home.join("content");
        ensure_directory(&content)?;
        let root = content.join("v1");
        ensure_directory(&root)?;
        Ok(Self { root })
    }

    pub fn import(
        &self,
        original_name: String,
        declared_media_type: Option<&str>,
        bytes: &[u8],
    ) -> Result<ContentAsset, ContentStoreError> {
        validate_original_name(&original_name)?;
        let detected = detect_and_validate(bytes)?;
        if declared_media_type.is_some_and(|declared| declared != detected.media_type) {
            return Err(ContentStoreError::MediaTypeMismatch);
        }
        let sha256 = sha256_hex(bytes);
        let asset = ContentAsset {
            asset_id: format!("ast_{sha256}"),
            sha256: sha256.clone(),
            media_type: detected.media_type.to_owned(),
            original_name,
            size_bytes: u64::try_from(bytes.len()).map_err(|_| ContentStoreError::TooLarge)?,
            kind: detected.kind,
            pdf_pages: detected.pdf_pages,
        };
        let target = self.asset_path(&sha256)?;
        match fs::symlink_metadata(&target) {
            Ok(metadata) => {
                if !metadata.file_type().is_file() {
                    return Err(ContentStoreError::UnsafeStore);
                }
                let existing = fs::read(&target).map_err(ContentStoreError::Io)?;
                if existing != bytes {
                    return Err(ContentStoreError::HashMismatch);
                }
                return Ok(asset);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(ContentStoreError::Io(error)),
        }
        let mut temp = NamedTempFile::new_in(&self.root).map_err(ContentStoreError::Io)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temp.as_file()
                .set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(ContentStoreError::Io)?;
        }
        temp.write_all(bytes).map_err(ContentStoreError::Io)?;
        temp.flush().map_err(ContentStoreError::Io)?;
        temp.as_file().sync_all().map_err(ContentStoreError::Io)?;
        match temp.persist_noclobber(&target) {
            Ok(_) => {}
            Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
                let existing = fs::read(&target).map_err(ContentStoreError::Io)?;
                if existing != bytes {
                    return Err(ContentStoreError::HashMismatch);
                }
            }
            Err(error) => return Err(ContentStoreError::Io(error.error)),
        }
        sync_directory(&self.root)?;
        Ok(asset)
    }

    pub fn read_verified(&self, asset: &ContentAsset) -> Result<Vec<u8>, ContentStoreError> {
        validate_asset_descriptor(asset)?;
        let bytes = self.read_verified_descriptor(
            &asset.asset_id,
            &asset.sha256,
            &asset.media_type,
            &asset.original_name,
            asset.size_bytes,
        )?;
        let detected = detect_and_validate(&bytes)?;
        if detected.kind != asset.kind || detected.pdf_pages != asset.pdf_pages {
            return Err(ContentStoreError::HashMismatch);
        }
        Ok(bytes)
    }

    pub fn read_verified_descriptor(
        &self,
        asset_id: &str,
        sha256: &str,
        media_type: &str,
        original_name: &str,
        size_bytes: u64,
    ) -> Result<Vec<u8>, ContentStoreError> {
        validate_original_name(original_name)?;
        if asset_id != format!("ast_{sha256}") || !valid_sha256(sha256) || size_bytes == 0 {
            return Err(ContentStoreError::InvalidAsset);
        }
        let path = self.asset_path(sha256)?;
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                ContentStoreError::Missing
            } else {
                ContentStoreError::Io(error)
            }
        })?;
        if !metadata.file_type().is_file() {
            return Err(ContentStoreError::UnsafeStore);
        }
        if metadata.len() != size_bytes {
            return Err(ContentStoreError::HashMismatch);
        }
        let bytes = fs::read(path).map_err(ContentStoreError::Io)?;
        if sha256_hex(&bytes) != sha256 {
            return Err(ContentStoreError::HashMismatch);
        }
        let detected = detect_and_validate(&bytes)?;
        if detected.media_type != media_type {
            return Err(ContentStoreError::HashMismatch);
        }
        Ok(bytes)
    }

    fn asset_path(&self, sha256: &str) -> Result<PathBuf, ContentStoreError> {
        if !valid_sha256(sha256) {
            return Err(ContentStoreError::InvalidAsset);
        }
        Ok(self.root.join(sha256))
    }
}

#[derive(Debug)]
pub enum ContentStoreError {
    InvalidAsset,
    InvalidName,
    UnsupportedMediaType,
    MediaTypeMismatch,
    TooLarge,
    InvalidUtf8,
    AnimatedImage,
    InvalidPdf,
    PdfPageLimit,
    Missing,
    HashMismatch,
    UnsafeStore,
    Io(io::Error),
}

impl fmt::Display for ContentStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidAsset => "invalid content asset",
            Self::InvalidName => "invalid original file name",
            Self::UnsupportedMediaType => "unsupported content media type",
            Self::MediaTypeMismatch => "declared media type does not match file content",
            Self::TooLarge => "content exceeds the size limit",
            Self::InvalidUtf8 => "text content is not valid UTF-8",
            Self::AnimatedImage => "animated images are not supported",
            Self::InvalidPdf => "PDF structure is invalid or unsupported",
            Self::PdfPageLimit => "PDF exceeds the page limit",
            Self::Missing => "content asset is missing",
            Self::HashMismatch => "content asset integrity check failed",
            Self::UnsafeStore => "content store contains an unsafe filesystem entry",
            Self::Io(_) => "content store is unavailable",
        })
    }
}

impl Error for ContentStoreError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

struct DetectedContent {
    kind: ContentAssetKind,
    media_type: &'static str,
    pdf_pages: Option<u32>,
}

fn detect_and_validate(bytes: &[u8]) -> Result<DetectedContent, ContentStoreError> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        enforce_size(bytes, MAX_IMAGE_BYTES)?;
        return Ok(DetectedContent {
            kind: ContentAssetKind::Image,
            media_type: "image/png",
            pdf_pages: None,
        });
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) && bytes.ends_with(&[0xff, 0xd9]) {
        enforce_size(bytes, MAX_IMAGE_BYTES)?;
        return Ok(DetectedContent {
            kind: ContentAssetKind::Image,
            media_type: "image/jpeg",
            pdf_pages: None,
        });
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        enforce_size(bytes, MAX_IMAGE_BYTES)?;
        if bytes.windows(4).any(|window| window == b"ANIM") {
            return Err(ContentStoreError::AnimatedImage);
        }
        return Ok(DetectedContent {
            kind: ContentAssetKind::Image,
            media_type: "image/webp",
            pdf_pages: None,
        });
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        enforce_size(bytes, MAX_IMAGE_BYTES)?;
        if gif_frame_count(bytes) != 1 {
            return Err(ContentStoreError::AnimatedImage);
        }
        return Ok(DetectedContent {
            kind: ContentAssetKind::Image,
            media_type: "image/gif",
            pdf_pages: None,
        });
    }
    if bytes.starts_with(b"%PDF-") {
        enforce_size(bytes, MAX_PDF_BYTES)?;
        let pdf_pages = pdf_page_count(bytes)?;
        return Ok(DetectedContent {
            kind: ContentAssetKind::Pdf,
            media_type: "application/pdf",
            pdf_pages: Some(pdf_pages),
        });
    }
    enforce_size(bytes, MAX_TEXT_BYTES)?;
    std::str::from_utf8(bytes).map_err(|_| ContentStoreError::InvalidUtf8)?;
    Ok(DetectedContent {
        kind: ContentAssetKind::Text,
        media_type: "text/plain",
        pdf_pages: None,
    })
}

fn enforce_size(bytes: &[u8], maximum: usize) -> Result<(), ContentStoreError> {
    if bytes.is_empty() {
        Err(ContentStoreError::UnsupportedMediaType)
    } else if bytes.len() > maximum {
        Err(ContentStoreError::TooLarge)
    } else {
        Ok(())
    }
}

fn gif_frame_count(bytes: &[u8]) -> usize {
    bytes.iter().filter(|byte| **byte == 0x2c).take(2).count()
}

fn pdf_page_count(bytes: &[u8]) -> Result<u32, ContentStoreError> {
    if !bytes.ends_with(b"%%EOF") && !bytes.ends_with(b"%%EOF\n") && !bytes.ends_with(b"%%EOF\r\n")
    {
        return Err(ContentStoreError::InvalidPdf);
    }
    if bytes.windows(8).any(|window| window == b"/Encrypt") {
        return Err(ContentStoreError::InvalidPdf);
    }
    let mut pages = 0u32;
    let mut cursor = 0usize;
    while let Some(relative) = find_bytes(&bytes[cursor..], b"/Type") {
        cursor = cursor.saturating_add(relative).saturating_add(5);
        let tail = &bytes[cursor..];
        let tail = trim_pdf_space(tail);
        if tail.starts_with(b"/Page") && tail.get(5).is_none_or(|byte| is_pdf_delimiter(*byte)) {
            pages = pages
                .checked_add(1)
                .ok_or(ContentStoreError::PdfPageLimit)?;
            if pages > MAX_PDF_PAGES {
                return Err(ContentStoreError::PdfPageLimit);
            }
        }
    }
    if pages == 0 {
        Err(ContentStoreError::InvalidPdf)
    } else {
        Ok(pages)
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn trim_pdf_space(mut bytes: &[u8]) -> &[u8] {
    while bytes.first().is_some_and(|byte| byte.is_ascii_whitespace()) {
        bytes = &bytes[1..];
    }
    bytes
}

fn is_pdf_delimiter(byte: u8) -> bool {
    byte.is_ascii_whitespace() || matches!(byte, b'/' | b'>' | b'<' | b'[' | b']' | b'(' | b')')
}

fn validate_original_name(name: &str) -> Result<(), ContentStoreError> {
    let path = Path::new(name);
    if name.is_empty()
        || name.len() > 255
        || name.chars().any(char::is_control)
        || path.file_name().and_then(|value| value.to_str()) != Some(name)
    {
        Err(ContentStoreError::InvalidName)
    } else {
        Ok(())
    }
}

fn validate_asset_descriptor(asset: &ContentAsset) -> Result<(), ContentStoreError> {
    if asset.asset_id != format!("ast_{}", asset.sha256)
        || !valid_sha256(&asset.sha256)
        || asset.size_bytes == 0
    {
        return Err(ContentStoreError::InvalidAsset);
    }
    validate_original_name(&asset.original_name)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn ensure_directory(path: &Path) -> Result<(), ContentStoreError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => Err(ContentStoreError::UnsafeStore),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(ContentStoreError::Io)
        }
        Err(error) => Err(ContentStoreError::Io(error)),
    }
}

fn sync_directory(_path: &Path) -> Result<(), ContentStoreError> {
    #[cfg(unix)]
    fs::File::open(_path)
        .and_then(|directory| directory.sync_all())
        .map_err(ContentStoreError::Io)?;
    Ok(())
}
