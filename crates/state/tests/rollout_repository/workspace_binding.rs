use super::*;

#[test]
fn workspace_bound_repositories_never_resume_foreign_or_unbound_threads() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let binding_a = "a".repeat(64);
    let binding_b = "b".repeat(64);
    let thread_a = ThreadId::new("thr_0000000000000001");
    let thread_b = ThreadId::new("thr_0000000000000002");

    {
        let mut repository =
            RolloutRepository::open_with_workspace_binding(&home, Some(&binding_a))
                .expect("workspace A");
        repository.create_thread(&thread_a).expect("thread A");
    }
    {
        let mut repository =
            RolloutRepository::open_with_workspace_binding(&home, Some(&binding_b))
                .expect("workspace B");
        assert!(repository.load_thread(&thread_a).expect("load A").is_none());
        repository.create_thread(&thread_b).expect("thread B");
        assert_eq!(
            repository.list_threads(None, 50).expect("list B").data,
            vec![sugarcode_state::DurableThreadSummary {
                id: thread_b.clone(),
            }]
        );
    }
    {
        let mut repository =
            RolloutRepository::open_with_workspace_binding(&home, Some(&binding_a))
                .expect("reopen A");
        assert_eq!(
            repository.list_threads(None, 50).expect("list A").data,
            vec![sugarcode_state::DurableThreadSummary {
                id: thread_a.clone(),
            }]
        );
        assert!(repository.load_thread(&thread_b).expect("load B").is_none());
    }

    let record = fs::read_to_string(
        directory
            .path()
            .join("rollouts/v1/thr_0000000000000001.jsonl"),
    )
    .expect("rollout");
    assert!(record.contains(&format!("\"workspaceBindingId\":\"{binding_a}\"")));
}
