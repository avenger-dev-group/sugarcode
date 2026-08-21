use crate::ContentStore;
use crate::ContentStoreError;

fn store() -> (tempfile::TempDir, ContentStore) {
    let directory = tempfile::tempdir().expect("home");
    let store = ContentStore::open_at(directory.path()).expect("store");
    (directory, store)
}

#[test]
fn imports_deduplicates_and_verifies_utf8_content() {
    let (_directory, store) = store();
    let first = store
        .import("notes.txt".to_owned(), Some("text/plain"), b"hello")
        .expect("import");
    let second = store
        .import("renamed.txt".to_owned(), Some("text/plain"), b"hello")
        .expect("deduplicate");
    assert_eq!(first.asset_id, second.asset_id);
    assert_eq!(store.read_verified(&first).expect("verified"), b"hello");
}

#[test]
fn rejects_spoofed_mime_animated_gif_and_large_pdf() {
    let (_directory, store) = store();
    assert!(matches!(
        store.import("fake.png".to_owned(), Some("image/png"), b"plain text"),
        Err(ContentStoreError::MediaTypeMismatch)
    ));
    let mut animated = b"GIF89a".to_vec();
    animated.extend_from_slice(&[0x2c, 0x2c]);
    assert!(matches!(
        store.import("animated.gif".to_owned(), Some("image/gif"), &animated),
        Err(ContentStoreError::AnimatedImage)
    ));
    let pdf = b"%PDF-1.7\n1 0 obj <</Type /Page>> endobj\n2 0 obj <</Type /Page>> endobj\n%%EOF";
    let asset = store
        .import("two.pdf".to_owned(), Some("application/pdf"), pdf)
        .expect("PDF");
    assert_eq!(asset.pdf_pages, Some(2));
}

#[test]
fn imports_and_verifies_supported_video_containers() {
    let (_directory, store) = store();
    let mp4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom";
    let asset = store
        .import("clip.mp4".to_owned(), Some("video/mp4"), mp4)
        .expect("MP4");
    assert_eq!(asset.kind.as_str(), "video");
    assert_eq!(asset.media_type, "video/mp4");
    assert_eq!(store.read_verified(&asset).expect("verified"), mp4);

    let webm = b"\x1a\x45\xdf\xa3\x42\x82\x84webm";
    let asset = store
        .import("clip.webm".to_owned(), Some("video/webm"), webm)
        .expect("WebM");
    assert_eq!(asset.kind.as_str(), "video");
    assert_eq!(asset.media_type, "video/webm");
}

#[test]
fn imports_modern_and_quicktime_iso_video_variants() {
    let (_directory, store) = store();
    let modern_mp4 = b"\x00\x00\x00\x08free\x00\x00\x00\x18ftypiso8\x00\x00\x00\x00iso8dash";
    let asset = store
        .import("capture.mp4".to_owned(), Some("video/mp4"), modern_mp4)
        .expect("modern MP4");
    assert_eq!(asset.media_type, "video/mp4");

    let quicktime = b"\x00\x00\x00\x18ftypqt  \x00\x00\x00\x00qt  isom";
    let asset = store
        .import("capture.mp4".to_owned(), Some("video/mp4"), quicktime)
        .expect("QuickTime-compatible MP4 declaration");
    assert_eq!(asset.media_type, "video/quicktime");
}

#[test]
fn imports_large_video_from_path_without_the_inline_turn_limit() {
    let (directory, store) = store();
    let source_path = directory.path().join("large.mp4");
    let mut bytes = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom".to_vec();
    bytes.resize(21 * 1024 * 1024, 0);
    std::fs::write(&source_path, &bytes).expect("video fixture");
    let asset = store
        .import_video_path("large.mp4".to_owned(), Some("video/mp4"), &source_path)
        .expect("path import");
    assert_eq!(asset.size_bytes, bytes.len() as u64);
    assert_eq!(asset.kind.as_str(), "video");
    assert!(
        store
            .verified_video_path(&asset)
            .expect("verified")
            .is_file()
    );
}

#[test]
fn rejects_spoofed_and_malformed_video_containers() {
    let (_directory, store) = store();
    let mp4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom";
    assert!(matches!(
        store.import("clip.mp4".to_owned(), Some("video/webm"), mp4),
        Err(ContentStoreError::MediaTypeMismatch)
    ));
    assert!(matches!(
        store.import(
            "broken.mp4".to_owned(),
            Some("video/mp4"),
            b"\x00\x00\xff\xffftypmp42"
        ),
        Err(ContentStoreError::InvalidUtf8)
    ));
}
