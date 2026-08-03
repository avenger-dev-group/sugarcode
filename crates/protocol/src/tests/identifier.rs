use crate::ItemId;
use crate::ThreadId;
use crate::TurnId;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;

const FIXED_V7: &str = "00000000-0000-7000-8000-000000000001";

#[test]
fn new_ids_are_canonical_lowercase_uuid_v7_values() {
    let thread_id = ThreadId::new_v7();
    let turn_id = TurnId::new_v7();
    let item_id = ItemId::new_v7();

    for value in [thread_id.as_str(), turn_id.as_str(), item_id.as_str()] {
        assert_eq!(value.len(), 36);
        assert_eq!(&value[14..15], "7");
        assert!(matches!(&value[19..20], "8" | "9" | "a" | "b"));
        assert_eq!(value, value.to_lowercase());
    }
    assert_eq!(
        ThreadId::parse(thread_id.as_str()).expect("thread"),
        thread_id
    );
    assert_eq!(TurnId::parse(turn_id.as_str()).expect("turn"), turn_id);
    assert_eq!(ItemId::parse(item_id.as_str()).expect("item"), item_id);
}

#[test]
fn strict_parsing_rejects_old_non_v7_and_noncanonical_forms() {
    for invalid in [
        "thr_0000000000000001",
        "turn_0000000000000001",
        "item_0000000000000001",
        "550e8400-e29b-41d4-a716-446655440000",
        "00000000-0000-7000-8000-000000000001 ",
        "00000000000070008000000000000001",
        "00000000-0000-7000-8000-00000000000A",
    ] {
        assert!(ThreadId::parse(invalid).is_err(), "accepted {invalid}");
        assert!(TurnId::parse(invalid).is_err(), "accepted {invalid}");
        assert!(ItemId::parse(invalid).is_err(), "accepted {invalid}");
    }
    assert!(ThreadId::parse(FIXED_V7).is_ok());
}

#[test]
fn concurrent_generation_is_unique_across_id_kinds() {
    const WORKERS: usize = 8;
    const IDS_PER_WORKER: usize = 500;
    let ids = Arc::new(Mutex::new(HashSet::with_capacity(
        WORKERS * IDS_PER_WORKER * 3,
    )));
    let workers = (0..WORKERS)
        .map(|_| {
            let ids = Arc::clone(&ids);
            std::thread::spawn(move || {
                let mut generated = Vec::with_capacity(IDS_PER_WORKER * 3);
                for _ in 0..IDS_PER_WORKER {
                    generated.push(ThreadId::new_v7().into_string());
                    generated.push(TurnId::new_v7().into_string());
                    generated.push(ItemId::new_v7().into_string());
                }
                ids.lock().expect("ID set lock").extend(generated);
            })
        })
        .collect::<Vec<_>>();

    for worker in workers {
        worker.join().expect("ID worker");
    }
    assert_eq!(
        ids.lock().expect("ID set lock").len(),
        WORKERS * IDS_PER_WORKER * 3
    );
}

#[test]
fn serde_rejects_non_v7_ids() {
    assert!(serde_json::from_str::<ThreadId>(r#""thr_0000000000000001""#).is_err());
    assert!(serde_json::from_str::<TurnId>(r#""550e8400-e29b-41d4-a716-446655440000""#).is_err());
    assert!(serde_json::from_str::<ItemId>(r#""00000000-0000-7000-8000-00000000000A""#).is_err());
}
