import { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { matchKeyCombo } from '../hooks/useSettings';
import HintBadge from './HintBadge';
import '@xterm/xterm/css/xterm.css';

const PROMPT_TAIL_SIZE = 500;

const PROMPT_PATTERNS = [
  />\s*$/,
  /\?\s*$/,
  /\$\s*$/,
  /Ask Codex to do anything/i,
  /Would you like to run/i,
  /Implement this plan\?/i,
  /\[Y\/n\]/i,
  /\[y\/N\]/i,
];

function stripAnsi(text) {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '');
}

function isPromptOutput(text) {
  return PROMPT_PATTERNS.some(p => p.test(text));
}

const TerminalView = forwardRef(function TerminalView({
  session,
  onKillSession,
  onPauseSession,
  onResumeSession,
  onToggleSidebar,
  sidebarVisible,
  settings,
  onUpdateSession,
  hintModeActive = false,
  typedChars = '',
  hintCodes = {},
  onFocus,
  hideHeader = false
}, ref) {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const wsRef = useRef(null);
  const currentSessionId = useRef(null);
  const [sessionStatus, setSessionStatus] = useState(session?.status || 'active');
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState(session?.name || '');
  const ctrlCPendingRef = useRef(false);
  const ctrlCTimerRef = useRef(null);
  const keyboardSettingsRef = useRef(null);
  const [overrideKeys, setOverrideKeys] = useState(false);
  const overrideKeysRef = useRef(false);
  const lastPromptLineRef = useRef(null);
  const outputTailRef = useRef('');

  // Expose focus method to parent via ref
  useImperativeHandle(ref, () => ({
    focus: () => {
      xtermRef.current?.focus();
    }
  }), []);

  const trackPromptFromOutput = useCallback((rawText) => {
    const stripped = stripAnsi(rawText);
    outputTailRef.current = (outputTailRef.current + stripped).slice(-PROMPT_TAIL_SIZE);
    const lastLine = outputTailRef.current.split(/\r?\n/).pop()?.trim() || '';
    if (lastLine.length > 0 && isPromptOutput(lastLine)) {
      const buf = xtermRef.current.buffer.active;
      lastPromptLineRef.current = buf.baseY + buf.cursorY;
    }
  }, []);

  const connect = useCallback((sessionId) => {
    if (wsRef.current) {
      wsRef.current.close();
    }

    // Use same host - Vite will proxy in dev mode
    const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/socket/sessions/${sessionId}/terminal`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      // Send initial resize
      if (xtermRef.current) {
        ws.send(JSON.stringify({
          type: 'resize',
          cols: xtermRef.current.cols,
          rows: xtermRef.current.rows
        }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'output' && xtermRef.current) {
          xtermRef.current.write(data.data, () => {
            trackPromptFromOutput(data.data);
          });
        } else if (data.type === 'status') {
          setSessionStatus(data.status);
        } else if (data.type === 'sessionEnded') {
          xtermRef.current?.write('\r\n\x1b[33m--- Session ended ---\x1b[0m\r\n');
          setSessionStatus('completed');
        } else if (data.type === 'error') {
          xtermRef.current?.write(`\r\n\x1b[31mError: ${data.error}\x1b[0m\r\n`);
        }
      } catch (error) {
        // Handle non-JSON messages (raw terminal output)
        if (xtermRef.current && typeof event.data === 'string') {
          xtermRef.current.write(event.data, () => {
            trackPromptFromOutput(event.data);
          });
        }
      }
    };

    ws.onclose = () => {
      // WebSocket closed
    };

    ws.onerror = (error) => {
      console.error('Terminal WebSocket error:', error);
    };
  }, [trackPromptFromOutput]);

  // Get terminal settings with defaults
  const terminalSettings = settings?.terminal || {
    fontSize: 14,
    fontFamily: "Consolas, Monaco, 'Courier New', monospace",
    cursorStyle: 'block',
    cursorBlink: true
  };

  const keyboardSettings = settings?.keyboard || {
    copyKey: 'Ctrl+C',
    pasteKey: 'Ctrl+V',
    cancelKey: 'Ctrl+C',
    clearKey: 'Ctrl+L'
  };

  useEffect(() => {
    keyboardSettingsRef.current = keyboardSettings;
  }, [keyboardSettings.copyKey, keyboardSettings.pasteKey, keyboardSettings.cancelKey, keyboardSettings.clearKey]);

  useEffect(() => {
    overrideKeysRef.current = overrideKeys;
    window.__terminalOverrideKeys = overrideKeys;
  }, [overrideKeys]);

  // Initialize terminal
  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new Terminal({
      cursorBlink: terminalSettings.cursorBlink,
      cursorStyle: terminalSettings.cursorStyle,
      fontFamily: terminalSettings.fontFamily,
      fontSize: terminalSettings.fontSize,
      lineHeight: 1.2,
      theme: {
        background: '#0d0d0d',
        foreground: '#e4e4e4',
        cursor: '#00ff00',
        cursorAccent: '#0d0d0d',
        selectionBackground: 'rgba(255, 255, 255, 0.3)',
        black: '#000000',
        red: '#ff5555',
        green: '#50fa7b',
        yellow: '#f1fa8c',
        blue: '#6272a4',
        magenta: '#ff79c6',
        cyan: '#8be9fd',
        white: '#f8f8f2',
        brightBlack: '#6272a4',
        brightRed: '#ff6e6e',
        brightGreen: '#69ff94',
        brightYellow: '#ffffa5',
        brightBlue: '#d6acff',
        brightMagenta: '#ff92df',
        brightCyan: '#a4ffff',
        brightWhite: '#ffffff'
      }
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    term.open(terminalRef.current);
    fitAddon.fit();

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') {
        return true;
      }

      // Ctrl+Enter sends newline directly to the session.
      if (event.ctrlKey && event.key === 'Enter') {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'input', data: '\n' }));
        }
        return false;
      }

      // Handle dedicated copy shortcut (when different from cancel key)
      const copyKey = keyboardSettingsRef.current?.copyKey || 'Ctrl+C';
      const cancelKey = keyboardSettingsRef.current?.cancelKey || 'Ctrl+C';
      if (copyKey !== cancelKey && matchKeyCombo(event, copyKey)) {
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard?.writeText(selection).catch((error) => {
            console.error('Failed to copy selection:', error);
          });
        }
        return false;
      }

      if (matchKeyCombo(event, cancelKey)) {
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard?.writeText(selection).catch((error) => {
            console.error('Failed to copy selection:', error);
          });
          return false;
        }

        if (ctrlCPendingRef.current) {
          ctrlCPendingRef.current = false;
          if (ctrlCTimerRef.current) {
            clearTimeout(ctrlCTimerRef.current);
            ctrlCTimerRef.current = null;
          }
          return true;
        }

        ctrlCPendingRef.current = true;
        if (ctrlCTimerRef.current) {
          clearTimeout(ctrlCTimerRef.current);
        }
        term.write('\r\n\x1b[33mPress Ctrl+C again within 2s to send SIGINT.\x1b[0m\r\n');
        ctrlCTimerRef.current = setTimeout(() => {
          ctrlCPendingRef.current = false;
          ctrlCTimerRef.current = null;
        }, 2000);
        return false;
      }

      // Intercept paste shortcut before xterm consumes it
      const pasteKey = keyboardSettingsRef.current?.pasteKey || 'Ctrl+V';
      if (matchKeyCombo(event, pasteKey)) {
        navigator.clipboard.readText().then(text => {
          if (text && wsRef.current?.readyState === WebSocket.OPEN) {
            const pastedText = text.replace(/(\r\n|\r|\n)+$/, '');
            if (!pastedText) return;
            wsRef.current.send(JSON.stringify({ type: 'input', data: pastedText }));
          }
        }).catch(err => {
          console.error('Failed to read clipboard:', err);
        });
        return false;
      }

      // When override mode is ON, let the terminal handle all keys
      // (except Ctrl+C cancel and paste which are always handled above)
      if (overrideKeysRef.current) {
        return true;
      }

      // Intercept app-level shortcuts so xterm doesn't consume them
      // Session navigation: Ctrl+[ Ctrl+] Ctrl+; Ctrl+'
      if (event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
        if (event.code === 'BracketLeft' || event.code === 'BracketRight' ||
            event.key === ';' || event.key === "'" || event.key.toLowerCase() === 'w') {
          return false;
        }
      }
      if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'w') {
        return false;
      }
      // Ctrl+Up/Down: scroll to prompt / bottom
      if (event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey &&
          (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        return false;
      }
      // Panel resize: Ctrl+Alt+Arrow keys
      if (event.ctrlKey && event.altKey) {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          return false;
        }
      }

      // Pane split shortcuts are handled at app level.
      if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
        if (event.key === '+' || event.key === '=' || event.key === '-' || event.key === '_' ||
            event.code === 'NumpadAdd' || event.code === 'NumpadSubtract') {
          return false;
        }
      }

      // Alt+Arrow: pane focus navigation (handled at app level)
      if (event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey) {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' ||
            event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          return false;
        }
      }

      // Ctrl+Shift+W: close focused pane (handled at app level)
      if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey &&
          event.key.toLowerCase() === 'w') {
        return false;
      }

      // Ctrl+=/Ctrl+-: Electron zoom (must bubble to native handler)
      if (event.ctrlKey && !event.altKey && !event.metaKey &&
          (event.key === '=' || event.key === '+' || event.key === '-' || event.key === '_' ||
           event.code === 'NumpadAdd' || event.code === 'NumpadSubtract')) {
        return false;
      }

      return true;
    });

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Handle user input
    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'input', data }));
      }
      // Track prompt line when user presses Enter
      if (data.includes('\r') || data.includes('\n')) {
        const buf = term.buffer.active;
        lastPromptLineRef.current = buf.baseY + buf.cursorY;
      }
    });

    // Handle resize
    const handleResize = () => {
      fitAddon.fit();
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'resize',
          cols: term.cols,
          rows: term.rows
        }));
      }
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(terminalRef.current);

    // Focus terminal
    term.focus();

    return () => {
      if (ctrlCTimerRef.current) {
        clearTimeout(ctrlCTimerRef.current);
        ctrlCTimerRef.current = null;
      }
      ctrlCPendingRef.current = false;
      window.__terminalOverrideKeys = false;
      resizeObserver.disconnect();
      term.dispose();
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  // Connect to session when session ID changes
  // Status updates come via WebSocket (line 66), not props
  useEffect(() => {
    if (!session?.id) return;

    // Only reconnect if session changed
    if (currentSessionId.current !== session.id) {
      currentSessionId.current = session.id;

      // Clear terminal and prompt tracking for new session
      lastPromptLineRef.current = null;
      outputTailRef.current = '';
      if (xtermRef.current) {
        xtermRef.current.clear();
      }

      connect(session.id);
    }
  }, [session?.id, connect]);

  // Update terminal settings when they change
  useEffect(() => {
    if (!xtermRef.current) return;

    const term = xtermRef.current;

    // Update font settings
    term.options.fontSize = terminalSettings.fontSize;
    term.options.fontFamily = terminalSettings.fontFamily;
    term.options.cursorStyle = terminalSettings.cursorStyle;
    term.options.cursorBlink = terminalSettings.cursorBlink;

    // Refit terminal after font changes
    if (fitAddonRef.current) {
      fitAddonRef.current.fit();
    }
  }, [terminalSettings.fontSize, terminalSettings.fontFamily, terminalSettings.cursorStyle, terminalSettings.cursorBlink]);

  const scrollToLastPrompt = useCallback(() => {
    if (!xtermRef.current) return;
    if (lastPromptLineRef.current !== null) {
      xtermRef.current.scrollToLine(lastPromptLineRef.current);
    } else {
      xtermRef.current.scrollToBottom();
    }
  }, []);

  // Handle custom keyboard shortcuts
  useEffect(() => {
    if (!terminalRef.current) return;

    const handleKeyDown = (event) => {
      // Check for copy shortcut (skip if same as cancelKey — already handled inside xterm)
      if (keyboardSettings.copyKey !== keyboardSettings.cancelKey &&
          matchKeyCombo(event, keyboardSettings.copyKey)) {
        event.preventDefault();
        const selection = xtermRef.current?.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection);
        }
        return;
      }

      // Check for paste shortcut (also handled inside xterm, but keep as fallback)
      if (matchKeyCombo(event, keyboardSettings.pasteKey)) {
        event.preventDefault();
        navigator.clipboard.readText().then(text => {
          if (text && wsRef.current?.readyState === WebSocket.OPEN) {
            // Avoid implicit submit on paste when clipboard content ends with newline.
            const pastedText = text.replace(/(\r\n|\r|\n)+$/, '');
            if (!pastedText) return;
            wsRef.current.send(JSON.stringify({ type: 'input', data: pastedText }));
          }
        }).catch(err => {
          console.error('Failed to read clipboard:', err);
        });
        return;
      }

      // Check for clear shortcut
      if (matchKeyCombo(event, keyboardSettings.clearKey)) {
        event.preventDefault();
        xtermRef.current?.clear();
        return;
      }

      // Ctrl+Up: scroll to last prompt
      if (event.ctrlKey && event.key === 'ArrowUp' && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        scrollToLastPrompt();
        return;
      }

      // Ctrl+Down: scroll to bottom
      if (event.ctrlKey && event.key === 'ArrowDown' && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        xtermRef.current?.scrollToBottom();
        return;
      }

      // cancelKey is handled by xterm's custom key handler (for confirmation).
    };

    const terminalElement = terminalRef.current;
    terminalElement.addEventListener('keydown', handleKeyDown);

    return () => {
      terminalElement.removeEventListener('keydown', handleKeyDown);
    };
  }, [keyboardSettings.copyKey, keyboardSettings.pasteKey, keyboardSettings.clearKey, scrollToLastPrompt]);

  // Focus terminal when clicking
  const handleTerminalClick = () => {
    if (sessionStatus !== 'paused') {
      xtermRef.current?.focus();
    }
    onFocus?.();
  };

  const handlePause = () => {
    onPauseSession?.(session.id);
  };

  const handleResume = () => {
    onResumeSession?.(session.id);
  };

  const handleNameDoubleClick = () => {
    setIsEditingName(true);
    setEditName(session.name);
  };

  const handleNameBlur = () => {
    if (editName.trim() && editName !== session.name) {
      onUpdateSession?.(session.id, { name: editName.trim() });
    }
    setIsEditingName(false);
  };

  const handleNameKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.target.blur();
    } else if (e.key === 'Escape') {
      setEditName(session.name);
      setIsEditingName(false);
    }
  };

  const isPaused = sessionStatus === 'paused';
  const isCompleted = sessionStatus === 'completed';

  // Get context toggle hint code from settings or use default
  const contextToggleHint = hintCodes.contextToggle || 'ct';

  return (
    <div className="terminal-container">
      {!hideHeader && <div className="terminal-header">
        <div className="terminal-title" onDoubleClick={handleNameDoubleClick}>
          <span className={`status-indicator ${sessionStatus}`} />
          {isEditingName ? (
            <input
              type="text"
              className="terminal-name-input"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              onBlur={handleNameBlur}
              onKeyDown={handleNameKeyDown}
              autoFocus
            />
          ) : (
            <>
              {session.name}
              <span className="terminal-directory" title={session.workingDir}>
                {getDirectoryName(session.workingDir)}
              </span>
              <span className="terminal-last-activity">
                {formatRelativeTime(session.lastActivity)}
              </span>
            </>
          )}
        </div>
        <div className="terminal-actions">
          <button
            className={`btn btn-small ${overrideKeys ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setOverrideKeys(v => !v)}
            title="When ON, keyboard shortcuts are sent to the terminal instead of the app"
          >
            {overrideKeys ? 'KS: Terminal' : 'KS: App'}
          </button>
          <button
            className="btn btn-secondary btn-small"
            onClick={scrollToLastPrompt}
            title="Scroll to last prompt (Ctrl+Up)"
          >
            ↑ Prompt
          </button>
          <button
            className={`btn btn-secondary btn-small sidebar-toggle-btn ${sidebarVisible ? 'active' : ''}`}
            onClick={onToggleSidebar}
            title="Toggle Context Sidebar (Ctrl+B)"
          >
            <HintBadge
              code={contextToggleHint}
              visible={hintModeActive}
              position="top-left"
              action={onToggleSidebar}
              typedChars={typedChars}
            />
            {sidebarVisible ? '◀ Context' : 'Context ▶'}
          </button>
          {isPaused ? (
            <button className="btn btn-primary btn-small" onClick={handleResume}>
              Resume
            </button>
          ) : !isCompleted ? (
            <button className="btn btn-secondary btn-small" onClick={handlePause}>
              Pause
            </button>
          ) : null}
          <button className="btn btn-danger btn-small" onClick={onKillSession}>
            {isPaused || isCompleted ? 'Delete' : 'Kill'}
          </button>
        </div>
      </div>}
      <div className="terminal-wrapper-container">
        <div
          className={`terminal-wrapper ${isPaused ? 'paused' : ''}`}
          ref={terminalRef}
          onClick={handleTerminalClick}
        />
        {isPaused && (
          <div className="terminal-paused-overlay">
            <div className="paused-content">
              <div className="paused-icon">⏸️</div>
              <h3>Session Paused</h3>
              <p>Click Resume to continue this session</p>
              <button className="btn btn-primary" onClick={handleResume}>
                Resume Session
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

// Extract just the bottom-level directory name
function getDirectoryName(path) {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || '';
}

function formatRelativeTime(dateString) {
  if (!dateString) return '';

  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

export default TerminalView;
