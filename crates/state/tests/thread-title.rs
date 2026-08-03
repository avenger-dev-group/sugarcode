use sugarcode_protocol::{ItemId, ThreadId, TurnId};
use sugarcode_state::{
    DurableContentAsset, DurableItemSnapshot, DurableThreadLifecycle, DurableThreadSnapshot,
    DurableTurnSnapshot, DurableTurnStatus, DurableUserContentPart, derive_thread_title,
};

fn snapshot(messages: Vec<Vec<DurableUserContentPart>>) -> DurableThreadSnapshot {
    DurableThreadSnapshot {
        id: ThreadId::parse("00000000-0000-7000-8000-000000000001").expect("valid thread UUIDv7"),
        lifecycle: DurableThreadLifecycle::Active,
        origin: None,
        turns: messages
            .into_iter()
            .enumerate()
            .map(|(index, content)| DurableTurnSnapshot {
                id: TurnId::parse(format!("00000000-0001-7000-8000-{:012}", index + 1))
                    .expect("valid turn UUIDv7"),
                status: DurableTurnStatus::Completed,
                items: vec![DurableItemSnapshot::UserMessage {
                    id: ItemId::parse(format!("00000000-0002-7000-8000-{:012}", index + 1))
                        .expect("valid item UUIDv7"),
                    content,
                }],
                model: None,
                context_compaction: None,
                workspace_instructions: None,
                workspace_skills: None,
                error: None,
                usage: None,
            })
            .collect(),
    }
}

#[test]
fn title_uses_first_task_bearing_prompt_after_a_greeting() {
    let thread = snapshot(vec![
        vec![DurableUserContentPart::Text {
            text: "你好！".to_string(),
        }],
        vec![DurableUserContentPart::Text {
            text: "  优化  项目中的\n第一个问题  ".to_string(),
        }],
    ]);

    assert_eq!(
        derive_thread_title(&thread).as_deref(),
        Some("优化 项目中的 第一个问题")
    );
}

#[test]
fn title_is_unicode_safe_and_bounded() {
    let thread = snapshot(vec![vec![DurableUserContentPart::Text {
        text: "改".repeat(49),
    }]]);

    assert_eq!(
        derive_thread_title(&thread),
        Some(format!("{}…", "改".repeat(48)))
    );
}

#[test]
fn title_replaces_control_characters_with_word_boundaries() {
    let thread = snapshot(vec![vec![DurableUserContentPart::Text {
        text: "修复\0登录".to_string(),
    }]]);

    assert_eq!(derive_thread_title(&thread).as_deref(), Some("修复 登录"));
}

#[test]
fn attachment_only_prompt_uses_original_file_name() {
    let thread = snapshot(vec![vec![DurableUserContentPart::Document {
        asset: DurableContentAsset {
            asset_id: "asset_1".to_string(),
            sha256: "a".repeat(64),
            media_type: "application/pdf".to_string(),
            original_name: "需求说明.pdf".to_string(),
            size_bytes: 128,
        },
    }]]);

    assert_eq!(
        derive_thread_title(&thread).as_deref(),
        Some("处理 需求说明.pdf")
    );
}
