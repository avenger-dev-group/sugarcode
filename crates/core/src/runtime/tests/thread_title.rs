use super::super::thread_title::normalize_generated_title;
use super::*;

#[test]
fn generated_title_is_cleaned_and_bounded() {
    assert_eq!(
        normalize_generated_title("## “修复会话标题生成。”\nextra").as_deref(),
        Some("修复会话标题生成")
    );
    assert_eq!(
        normalize_generated_title(&"改".repeat(60)),
        Some("改".repeat(48))
    );
    assert_eq!(normalize_generated_title("任务 a940"), None);
    assert_eq!(
        normalize_generated_title("00000000-0000-7000-8000-000000000001"),
        None
    );
}

#[tokio::test]
async fn title_generation_persists_model_summary_and_emits_update() {
    let mut core = Core::new();
    let started = core
        .start_thread(CoreRequestId::new(1))
        .expect("start thread");
    let CoreEventKind::ThreadStarted { thread_id } = started.kind else {
        panic!("thread event");
    };
    core.prepare_text_turn(
        CoreRequestId::new(2),
        thread_id.clone(),
        Some("请先检查当前项目，然后修复左侧会话标题的显示问题".to_string()),
    )
    .expect("prepare user input");
    let provider = RecordedProvider {
        events: vec![Ok(model_event::final_response("修复会话标题显示"))],
        stay_open: false,
    };
    let (mut runtime, mut events) =
        CoreRuntime::new(core, Arc::new(provider), "fixture-model".to_string());

    runtime
        .generate_thread_title(CoreRequestId::new(3), thread_id.clone())
        .expect("start title generation");

    let event = events.recv().await.expect("title event");
    assert!(matches!(
        event.kind,
        CoreEventKind::ThreadTitleUpdated { ref title, .. }
            if title == "修复会话标题显示"
    ));
    assert_eq!(
        runtime
            .resume_thread(&thread_id)
            .expect("resume")
            .title
            .as_deref(),
        Some("修复会话标题显示")
    );
}
