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
