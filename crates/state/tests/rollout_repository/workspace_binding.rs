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
                title: None,
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
                title: None,
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

#[test]
fn workspace_free_repositories_only_resume_independent_threads() {
    let directory = tempdir().expect("home");
    let home = resolved_temp_home(&directory);
    let binding = "a".repeat(64);
    let project_thread = ThreadId::new("thr_0000000000000001");
    let independent_thread = ThreadId::new("thr_0000000000000002");

    {
        let mut repository = RolloutRepository::open_with_workspace_binding(&home, Some(&binding))
            .expect("project repository");
        repository
            .create_thread(&project_thread)
            .expect("project thread");
    }
    {
        let mut repository = RolloutRepository::open(&home).expect("independent repository");
        assert!(
            repository
                .load_thread(&project_thread)
                .expect("load project thread")
                .is_none()
        );
        repository
            .create_thread(&independent_thread)
            .expect("independent thread");
        assert_eq!(
            repository
                .list_threads(None, 50)
                .expect("independent list")
                .data,
            vec![sugarcode_state::DurableThreadSummary {
                id: independent_thread,
                title: None,
            }]
        );
    }
}
