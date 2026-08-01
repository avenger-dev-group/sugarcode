use crate::app::App;
use crate::app::Focus;
use ratatui::Frame;
use ratatui::layout::Constraint;
use ratatui::layout::Direction;
use ratatui::layout::Layout;
use ratatui::layout::Margin;
use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::text::Text;
use ratatui::widgets::Block;
use ratatui::widgets::Borders;
use ratatui::widgets::Clear;
use ratatui::widgets::List;
use ratatui::widgets::ListItem;
use ratatui::widgets::Paragraph;
use ratatui::widgets::Wrap;

const ACCENT: Color = Color::Rgb(255, 173, 51);
const MUTED: Color = Color::Rgb(135, 145, 158);

pub(crate) fn draw(frame: &mut Frame<'_>, app: &App) {
    let area = frame.area();
    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(6),
            Constraint::Length(3),
            Constraint::Length(1),
        ])
        .split(area);
    frame.render_widget(
        Line::from(vec![
            Span::styled(" SugarCode ", Style::default().fg(Color::Black).bg(ACCENT)),
            Span::raw("  "),
            Span::styled(
                compact_id(app.current_thread.as_str()),
                Style::default().fg(MUTED),
            ),
            Span::raw("  "),
            Span::styled(&app.status, Style::default().fg(Color::White)),
        ]),
        vertical[0],
    );

    let body = if area.width < 72 {
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Length(0), Constraint::Min(1)])
            .split(vertical[1])
    } else {
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Length(24), Constraint::Min(30)])
            .split(vertical[1])
    };
    if body[0].width > 0 {
        let items = app
            .threads
            .iter()
            .enumerate()
            .map(|(index, thread)| {
                let prefix = if index == app.selected_thread {
                    "› "
                } else {
                    "  "
                };
                ListItem::new(format!("{prefix}{}", compact_id(thread.as_str())))
            })
            .collect::<Vec<_>>();
        frame.render_widget(
            List::new(items).block(panel("Threads · n new", app.focus == Focus::Threads)),
            body[0],
        );
    }

    let mut transcript = app
        .transcript
        .iter()
        .flat_map(|entry| {
            [
                Line::styled(
                    entry.label.clone(),
                    Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
                ),
                Line::raw(entry.text.clone()),
                Line::raw(""),
            ]
        })
        .collect::<Vec<_>>();
    transcript.extend(app.pending_outputs.values().flat_map(|text| {
        [
            Line::styled(
                "Progress",
                Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
            ),
            Line::raw(text.clone()),
            Line::raw(""),
        ]
    }));
    frame.render_widget(
        Paragraph::new(Text::from(transcript))
            .block(panel(
                "Conversation · ↑↓/PgUp/PgDn scroll",
                app.focus == Focus::Transcript,
            ))
            .wrap(Wrap { trim: false })
            .scroll((app.scroll, 0)),
        body[1],
    );

    frame.render_widget(
        Paragraph::new(app.input.as_str())
            .block(panel(
                if app.focus == Focus::Input {
                    "Message · Enter send"
                } else {
                    "Message"
                },
                app.focus == Focus::Input,
            ))
            .wrap(Wrap { trim: false }),
        vertical[2],
    );
    frame.render_widget(
        Line::styled(
            " Tab focus · Ctrl+C stop/clear · Ctrl+Q safe exit · d latest diff ",
            Style::default().fg(MUTED),
        ),
        vertical[3],
    );

    if app.focus == Focus::Diff
        && let Some((path, diff)) = &app.latest_diff
    {
        let popup = area.inner(Margin {
            horizontal: (area.width / 10).max(1),
            vertical: (area.height / 8).max(1),
        });
        frame.render_widget(Clear, popup);
        frame.render_widget(
            Paragraph::new(diff.as_str())
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(ACCENT))
                        .title(format!(" Durable diff · {path} · Esc close ")),
                )
                .wrap(Wrap { trim: false })
                .scroll((app.diff_scroll, 0)),
            popup,
        );
    }

    if let Some(approval) = &app.approval {
        let popup = area.inner(Margin {
            horizontal: (area.width / 8).max(1),
            vertical: (area.height / 6).max(1),
        });
        frame.render_widget(Clear, popup);
        frame.render_widget(
            Paragraph::new(approval.detail())
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(Color::Red))
                        .title(" Approval · y approve once · n/Esc deny "),
                )
                .wrap(Wrap { trim: false }),
            popup,
        );
    }
}

fn panel(title: &'static str, focused: bool) -> Block<'static> {
    Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(if focused { ACCENT } else { MUTED }))
        .title(title)
}

fn compact_id(id: &str) -> &str {
    id.get(..id.len().min(18)).unwrap_or(id)
}
