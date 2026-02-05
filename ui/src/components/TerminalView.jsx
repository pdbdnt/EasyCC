import { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { matchKeyCombo } from '../hooks/useSettings';
import HintBadge from './HintBadge';
import '@xterm/xterm/css/xterm.css';

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
  onFocus
}, ref) {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const wsRef = useRef(null);
  const currentSessionId = useRef(null);
  const [sessionStatus, setSessionStatus] = useState(session?.status || 'active');
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState(session?.name || '');

  // Expose focus method to parent via ref
  useImperativeHandle(ref, () => ({
    focus: () => {
      xtermRef.current?.focus();
    }
  }), []);

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
          xtermRef.current.write(data.data);
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
          xtermRef.current.write(event.data);
        }
      }
    };

    ws.onclose = () => {
      // WebSocket closed
    };

    ws.onerror = (error) => {
      console.error('Terminal WebSocket error:', error);
    };
  }, []);

  // Get terminal settings with defaults
  const terminalSettings = settings?.terminal || {
    fontSize: 14,
    fontFamily: "Consolas, Monaco, 'Courier New', monospace",
    cursorStyle: 'block',
    cursorBlink: true
  };

  const keyboardSettings = settings?.keyboard || {
    copyKey: 'Ctrl+Shift+C',
    pasteKey: 'Ctrl+Shift+V',
    cancelKey: 'Ctrl+C',
    clearKey: 'Ctrl+L'
  };

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

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Handle user input
    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'input', data }));
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
      resizeObserver.disconnect();
      term.dispose();
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  // Connect to session when session changes
  useEffect(() => {
    if (!session?.id) return;

    // Update status from session prop
    setSessionStatus(session.status);

    // Only reconnect if session changed
    if (currentSessionId.current !== session.id) {
      currentSessionId.current = session.id;

      // Clear terminal for new session
      if (xtermRef.current) {
        xtermRef.current.clear();
      }

      connect(session.id);
    }
  }, [session?.id, session?.status, connect]);

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

  // Handle custom keyboard shortcuts
  useEffect(() => {
    if (!terminalRef.current) return;

    const handleKeyDown = (event) => {
      // Check for copy shortcut
      if (matchKeyCombo(event, keyboardSettings.copyKey)) {
        event.preventDefault();
        const selection = xtermRef.current?.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection);
        }
        return;
      }

      // Check for paste shortcut
      if (matchKeyCombo(event, keyboardSettings.pasteKey)) {
        event.preventDefault();
        navigator.clipboard.readText().then(text => {
          if (text && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'input', data: text }));
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

      // Note: cancelKey (Ctrl+C) is handled by the terminal itself
    };

    const terminalElement = terminalRef.current;
    terminalElement.addEventListener('keydown', handleKeyDown);

    return () => {
      terminalElement.removeEventListener('keydown', handleKeyDown);
    };
  }, [keyboardSettings.copyKey, keyboardSettings.pasteKey, keyboardSettings.clearKey]);

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
      <div className="terminal-header">
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
      </div>
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
