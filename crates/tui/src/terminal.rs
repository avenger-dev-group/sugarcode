use crate::app::App;
use crate::render;
use crossterm::cursor::Show;
use crossterm::event::DisableBracketedPaste;
use crossterm::event::EnableBracketedPaste;
use crossterm::execute;
use crossterm::terminal::EnterAlternateScreen;
use crossterm::terminal::LeaveAlternateScreen;
use crossterm::terminal::disable_raw_mode;
use crossterm::terminal::enable_raw_mode;
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use std::io;
use std::io::Stdout;

pub(crate) struct TerminalSession {
    terminal: Terminal<CrosstermBackend<Stdout>>,
}

impl TerminalSession {
    pub(crate) fn enter() -> io::Result<Self> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        if let Err(error) = execute!(stdout, EnterAlternateScreen, EnableBracketedPaste) {
            let _ = disable_raw_mode();
            return Err(error);
        }
        match Terminal::new(CrosstermBackend::new(stdout)) {
            Ok(mut terminal) => {
                if let Err(error) = terminal.clear() {
                    let _ = execute!(
                        terminal.backend_mut(),
                        DisableBracketedPaste,
                        LeaveAlternateScreen,
                        Show
                    );
                    let _ = disable_raw_mode();
                    return Err(error);
                }
                Ok(Self { terminal })
            }
            Err(error) => {
                let mut stdout = io::stdout();
                let _ = execute!(stdout, DisableBracketedPaste, LeaveAlternateScreen, Show);
                let _ = disable_raw_mode();
                Err(error)
            }
        }
    }

    pub(crate) fn draw(&mut self, app: &App) -> io::Result<()> {
        self.terminal.draw(|frame| render::draw(frame, app))?;
        Ok(())
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(
            self.terminal.backend_mut(),
            DisableBracketedPaste,
            LeaveAlternateScreen,
            Show
        );
    }
}
