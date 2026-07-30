use crate::app::App;
use crate::app::Focus;
use crate::render;
use ratatui::Terminal;
use ratatui::backend::TestBackend;

#[test]
fn narrow_unicode_layout_renders_without_overflow() {
    let backend = TestBackend::new(44, 14);
    let mut terminal = Terminal::new(backend).expect("terminal");
    let app = App::fixture();

    terminal
        .draw(|frame| render::draw(frame, &app))
        .expect("draw narrow frame");

    let rendered = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(rendered.contains("SugarCode"));
    assert!(rendered.contains('你'));
    assert!(rendered.contains('好'));
}

#[test]
fn durable_diff_panel_renders_file_and_diff() {
    let backend = TestBackend::new(90, 24);
    let mut terminal = Terminal::new(backend).expect("terminal");
    let mut app = App::fixture();
    app.focus = Focus::Diff;

    terminal
        .draw(|frame| render::draw(frame, &app))
        .expect("draw diff frame");

    let rendered = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(rendered.contains("src/main.rs"));
    assert!(rendered.contains("+新"));
}
