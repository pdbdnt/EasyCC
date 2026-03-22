import { useEffect, useRef, useCallback, useState, useMemo, forwardRef, useImperativeHandle } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { matchKeyCombo } from '../hooks/useSettings';
import HintBadge from './HintBadge';
import { getProjectDisplayName } from '../utils/projectUtils';
import '@xterm/xterm/css/xterm.css';

const TERMINAL_THEMES = {
  midnight: {
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
  },
  parchment: {
    background: '#1C1714',
    foreground: '#e8ddd0',
    cursor: '#C15F3C',
    cursorAccent: '#1C1714',
    selectionBackground: 'rgba(193, 95, 60, 0.35)',
    black: '#1C1714',
    red: '#ff6b6b',
    green: '#7ec99b',
    yellow: '#f0c070',
    blue: '#7ab0d4',
    magenta: '#d4a0c0',
    cyan: '#7dcfb6',
    white: '#c8bfb0',
    brightBlack: '#6b5e52',
    brightRed: '#ff8c8c',
    brightGreen: '#95e0b5',
    brightYellow: '#f5d090',
    brightBlue: '#90c4e0',
    brightMagenta: '#e0b8d0',
    brightCyan: '#95dfd0',
    brightWhite: '#f2ebe0'
  }
};

function getEffectiveTheme(theme) {
  if (!theme || theme === 'dark' || theme === 'midnight') return 'midnight';
  return theme;
}

function sanitizeSearchTerm(text) {
  return text
    .replace(/\x1b\[[0-9;]*[A-Za-z~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim()
    .substring(0, 60);
}

const TerminalView = forwardRef(function TerminalView({
  session,
  sessions,
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
  hideHeader = false,
  onUpdateSettings
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
  const searchAddonRef = useRef(null);
  const ecInputBufferRef = useRef('');
  const [ecResult, setEcResult] = useState(null);
  const [atPicker, setAtPicker] = useState(null); // null | { query: string, selectedIndex: number }
  const atPickerRef = useRef(null); // mirrors atPicker for use inside xterm closure
  const atPickerSelectRef = useRef(null); // ref to current selection handler
  const ecDismissTimerRef = useRef(null);
  const [easyccNotification, setEasyccNotification] = useState(null);
  const easyccNotificationTimerRef = useRef(null);
  const promptNavIndexRef = useRef(null);
  const promptHistoryRef = useRef([]);

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
      // Guard: ignore if this socket was superseded by a newer connect() call
      if (wsRef.current !== ws) return;
      if (xtermRef.current) {
        fitAddonRef.current?.fit(); // fit first so cols/rows are accurate
        ws.send(JSON.stringify({
          type: 'resize',
          cols: xtermRef.current.cols,
          rows: xtermRef.current.rows
        }));
        xtermRef.current.focus();
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'output' && xtermRef.current) {
          xtermRef.current.write(data.data);
        } else if (data.type === 'status') {
          setSessionStatus(data.status);
        } else if (data.type === 'easycc-notification') {
          if (easyccNotificationTimerRef.current) {
            clearTimeout(easyccNotificationTimerRef.current);
          }
          setEasyccNotification({
            command: 'EasyCC',
            message: data.message,
            timestamp: Date.now()
          });
          easyccNotificationTimerRef.current = setTimeout(() => {
            setEasyccNotification(null);
          }, 10000);
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
    cursorBlink: true,
    scrollback: 5000
  };

  const keyboardSettings = settings?.keyboard || {
    copyKey: 'Ctrl+C',
    pasteKey: 'Ctrl+V',
    cancelKey: 'Ctrl+C',
    clearKey: 'Ctrl+L'
  };

  useEffect(() => {
    keyboardSettingsRef.current = keyboardSettings;
  }, [keyboardSettings.copyKey, keyboardSettings.pasteKey, keyboardSettings.cancelKey, keyboardSettings.clearKey,
      keyboardSettings.navigation?.prevSession, keyboardSettings.navigation?.nextSession,
      keyboardSettings.navigation?.prevGroup, keyboardSettings.navigation?.nextGroup]);

  useEffect(() => {
    overrideKeysRef.current = overrideKeys;
    window.__terminalOverrideKeys = overrideKeys;
  }, [overrideKeys]);

  // Handle /ec- orchestrator commands
  const handleEcCommand = useCallback(async (cmd) => {
    // Dismiss any previous result
    if (ecDismissTimerRef.current) clearTimeout(ecDismissTimerRef.current);

    const parts = cmd.split(/\s+/);
    const command = parts[0].toLowerCase();
    const baseUrl = `${window.location.protocol}//${window.location.hostname}:${window.location.port || '5010'}`;

    try {
      if (command === '/ec-list' || command === '/ec-status') {
        const res = await fetch(`${baseUrl}/api/orchestrator/sessions`);
        const data = await res.json();
        setEcResult({ type: 'list', command, data: data.sessions, timestamp: Date.now() });

      } else if (command === '/ec-read') {
        const target = parts[1];
        if (!target) { setEcResult({ type: 'error', command, message: 'Usage: /ec-read <name-or-id>', timestamp: Date.now() }); return; }
        // Find session by name or ID
        const listRes = await fetch(`${baseUrl}/api/orchestrator/sessions`);
        const listData = await listRes.json();
        const match = listData.sessions.find(s => s.id === target || s.id.startsWith(target) || s.name.toLowerCase().includes(target.toLowerCase()));
        if (!match) { setEcResult({ type: 'error', command, message: `No session found matching "${target}"`, timestamp: Date.now() }); return; }
        const screenRes = await fetch(`${baseUrl}/api/orchestrator/sessions/${match.id}/screen?lines=30`);
        const screenData = await screenRes.json();
        setEcResult({ type: 'read', command, sessionName: match.name, data: screenData.screen, timestamp: Date.now() });

      } else if (command === '/ec-send') {
        const target = parts[1];
        const message = parts.slice(2).join(' ');
        if (!target || !message) { setEcResult({ type: 'error', command, message: 'Usage: /ec-send <name-or-id> <message>', timestamp: Date.now() }); return; }
        const listRes = await fetch(`${baseUrl}/api/orchestrator/sessions`);
        const listData = await listRes.json();
        const match = listData.sessions.find(s => s.id === target || s.id.startsWith(target) || s.name.toLowerCase().includes(target.toLowerCase()));
        if (!match) { setEcResult({ type: 'error', command, message: `No session found matching "${target}"`, timestamp: Date.now() }); return; }
        const sendRes = await fetch(`${baseUrl}/api/orchestrator/sessions/${match.id}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message, submit: true, fromSessionId: session?.id })
        });
        const sendData = await sendRes.json();
        if (sendData.ok) {
          setEcResult({ type: 'confirm', command, message: `Sent to "${match.name}"`, timestamp: Date.now() });
        } else {
          setEcResult({ type: 'error', command, message: sendData.error || 'Failed to send', timestamp: Date.now() });
        }

      } else if (command === '/ec-spawn') {
        const description = parts.slice(1).join(' ');
        // For AI sessions, send the description as a prompt to the AI
        if (session && (session.cliType === 'claude' || session.cliType === 'codex') && description) {
          const spawnPrompt = `Prepare to spawn a child agent session. The user wants: "${description}". Gather relevant context from the codebase, prepare a detailed role/prompt, then call the spawn API using curl with parentSessionId="${session.id}".`;
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'input', data: spawnPrompt + '\r' }));
          }
          setEcResult({ type: 'confirm', command, message: 'Spawn request sent to AI orchestrator', timestamp: Date.now() });
        } else {
          // For terminal sessions or no description, just show instructions
          setEcResult({ type: 'info', command, message: 'Use the New Session dialog to spawn a child session, or provide a description for AI sessions.', timestamp: Date.now() });
        }

      } else {
        setEcResult({ type: 'error', command, message: `Unknown command: ${command}. Available: /ec-list, /ec-status, /ec-read, /ec-send, /ec-spawn`, timestamp: Date.now() });
      }
    } catch (err) {
      setEcResult({ type: 'error', command, message: `Error: ${err.message}`, timestamp: Date.now() });
    }

    // Auto-dismiss after 10 seconds
    ecDismissTimerRef.current = setTimeout(() => setEcResult(null), 10000);
  }, [session]);

  const handleAtPickerSelect = useCallback((sessionName, sessionId) => {
    if (!sessionName) return;
    // Wrap name in quotes + embed #id for direct lookup, trailing space for message
    const idSuffix = sessionId ? `#${sessionId}` : '';
    const text = `'${sessionName}'${idSuffix} `;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data: text }));
    }
    ecInputBufferRef.current += text;
    atPickerRef.current = null; // sync immediately
    setAtPicker(null);
  }, []);

  // Keep atPickerRef in sync so the xterm closure can read current state
  useEffect(() => {
    atPickerRef.current = atPicker;
  }, [atPicker]);

  // Dismiss /ec- overlay on keystroke
  useEffect(() => {
    if (!ecResult) return;
    const dismiss = () => {
      setEcResult(null);
      if (ecDismissTimerRef.current) clearTimeout(ecDismissTimerRef.current);
    };
    const handleKey = (e) => {
      if (e.key !== 'Escape' && e.key.length > 1) return; // only dismiss on printable keys or Escape
      dismiss();
    };
    window.addEventListener('keydown', handleKey, { once: true });
    return () => window.removeEventListener('keydown', handleKey);
  }, [ecResult]);

  // Initialize terminal
  useEffect(() => {
    if (!terminalRef.current) return;

    const effectiveTheme = getEffectiveTheme(settings?.ui?.theme);
    const term = new Terminal({
      cursorBlink: terminalSettings.cursorBlink,
      cursorStyle: terminalSettings.cursorStyle,
      fontFamily: terminalSettings.fontFamily,
      fontSize: terminalSettings.fontSize,
      scrollback: terminalSettings.scrollback,
      lineHeight: 1.2,
      theme: TERMINAL_THEMES[effectiveTheme] || TERMINAL_THEMES.midnight
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const searchAddon = new SearchAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;

    term.open(terminalRef.current);
    fitAddon.fit();

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') {
        return true;
      }

      // @ picker keyboard handling (highest priority when picker is open)
      // Note: atPicker state is read via ref set below
      if (atPickerRef.current) {
        if (event.key === 'Escape') {
          atPickerRef.current = null;
          setAtPicker(null);
          return false;
        }
        // Double @@ = close picker and send literal @
        if (event.key === '@') {
          atPickerRef.current = null;
          setAtPicker(null);
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'input', data: '@' }));
          }
          return false;
        }
        if (event.key === 'ArrowDown') {
          setAtPicker(p => p ? { ...p, selectedIndex: p.selectedIndex + 1 } : null);
          return false;
        }
        if (event.key === 'ArrowUp') {
          setAtPicker(p => p ? { ...p, selectedIndex: Math.max(0, p.selectedIndex - 1) } : null);
          return false;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopImmediatePropagation();
          atPickerSelectRef.current?.();
          return false;
        }
        if (event.key === 'Backspace') {
          if (atPickerRef.current.query === '') {
            atPickerRef.current = null;
            setAtPicker(null);
          } else {
            setAtPicker(p => p ? { ...p, query: p.query.slice(0, -1), selectedIndex: 0 } : null);
          }
          return false;
        }
        // Printable chars: add to query filter
        if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
          setAtPicker(p => p ? { ...p, query: p.query + event.key, selectedIndex: 0 } : null);
          return false;
        }
        // All other keys suppressed from PTY
        return false;
      }

      // @ trigger: open session picker when typing /ec-send @
      if (event.key === '@' && !atPickerRef.current) {
        // Method 1: check tracked input buffer (populated by onData when user types)
        let hasEcSend = ecInputBufferRef.current.trimStart().startsWith('/ec-send');
        // Method 2 fallback: scan ALL visible rows of xterm buffer for /ec-send
        // This catches cases where Claude Code autocompleted the command (PTY-inserted text)
        if (!hasEcSend) {
          try {
            const buf = term.buffer.active;
            // Scan entire viewport bottom-up, stop at first match
            for (let r = buf.baseY + term.rows - 1; r >= buf.baseY; r--) {
              const line = buf.getLine(r);
              const text = line ? line.translateToString(true) : '';
              if (text.includes('/ec-send')) {
                hasEcSend = true;
                break;
              }
            }
          } catch (e) { /* ignore */ }
        }
        if (hasEcSend) {
          event.preventDefault();
          const state = { query: '', selectedIndex: 0 };
          atPickerRef.current = state; // sync ref immediately so onData sees it
          setAtPicker(state);
          return false; // suppress @ from reaching PTY
        }
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

      // Let browser handle paste (Ctrl+V) so xterm.js picks up the paste event
      // natively — it wraps pasted text with bracket paste sequences when the CLI enables them.
      const pasteKey = keyboardSettingsRef.current?.pasteKey || 'Ctrl+V';
      if (matchKeyCombo(event, pasteKey)) {
        return false;
      }

      // When override mode is ON, let the terminal handle all keys
      // (except Ctrl+C cancel and paste which are always handled above)
      if (overrideKeysRef.current) {
        return true;
      }

      // Intercept app-level shortcuts so xterm doesn't consume them
      // Ctrl+W close session
      if (event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && event.key.toLowerCase() === 'w') {
        return false;
      }
      // Session navigation (configurable keys)
      const navKeys = keyboardSettingsRef.current?.navigation;
      if (navKeys) {
        if (matchKeyCombo(event, navKeys.nextSession) ||
            matchKeyCombo(event, navKeys.prevSession) ||
            matchKeyCombo(event, navKeys.nextSessionGlobal) ||
            matchKeyCombo(event, navKeys.prevSessionGlobal) ||
            matchKeyCombo(event, navKeys.nextGroup) ||
            matchKeyCombo(event, navKeys.prevGroup)) {
          return false;
        }
      }
      if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'w') {
        return false;
      }
      // Ctrl+Up: step backwards through prompt history
      if (event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && event.key === 'ArrowUp') {
        event.preventDefault();
        const sa = searchAddonRef.current;
        if (!sa) return false;
        const history = promptHistoryRef.current;
        if (history.length === 0) return false;

        let idx;
        if (promptNavIndexRef.current === null) {
          idx = history.length - 1;
        } else if (promptNavIndexRef.current > 0) {
          idx = promptNavIndexRef.current - 1;
        } else {
          return false;
        }

        const searchTerm = sanitizeSearchTerm(history[idx].text);
        if (!searchTerm) return false;

        sa.clearDecorations();
        xtermRef.current.scrollToBottom();
        requestAnimationFrame(() => {
          sa.findPrevious(searchTerm, {
            regex: false,
            caseSensitive: true,
            decorations: {
              matchBackground: '#44444400',
              activeMatchBackground: '#665500',
              activeMatchColorOverviewRuler: '#ffaa00'
            }
          });
          promptNavIndexRef.current = idx;
        });
        return false;
      }

      // Ctrl+Down: step forwards through prompt history / scroll to bottom
      if (event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && event.key === 'ArrowDown') {
        event.preventDefault();
        const sa = searchAddonRef.current;
        if (!sa) return false;
        const history = promptHistoryRef.current;

        if (promptNavIndexRef.current !== null && promptNavIndexRef.current < history.length - 1) {
          const idx = promptNavIndexRef.current + 1;
          const searchTerm = sanitizeSearchTerm(history[idx].text);
          if (!searchTerm) return false;

          sa.clearDecorations();
          xtermRef.current.scrollToTop();
          requestAnimationFrame(() => {
            sa.findNext(searchTerm, {
              regex: false,
              caseSensitive: true,
              decorations: {
                matchBackground: '#44444400',
                activeMatchBackground: '#665500',
                activeMatchColorOverviewRuler: '#ffaa00'
              }
            });
            promptNavIndexRef.current = idx;
          });
        } else {
          sa.clearDecorations();
          xtermRef.current?.scrollToBottom();
          promptNavIndexRef.current = null;
        }
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
          (event.key.toLowerCase() === 'w' || event.key.toLowerCase() === 'g')) {
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

    // Handle user input — track buffer for @ picker context, pass everything to PTY
    term.onData((data) => {
      // When picker is open, all input is handled by attachCustomKeyEventHandler
      // This is a safety net — suppress everything from PTY while picker is open
      if (atPickerRef.current !== null) return;

      // Track buffer so @ picker knows the current line context
      if (data === '\x7f' || data === '\b') {
        ecInputBufferRef.current = ecInputBufferRef.current.slice(0, -1);
      } else if (data.includes('\r') || data.includes('\n')) {
        ecInputBufferRef.current = '';
        promptNavIndexRef.current = null;
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        ecInputBufferRef.current += data;
      } else if (data.length === 1 && data.charCodeAt(0) < 32) {
        // Single control char (Ctrl+C, Ctrl+D, etc.) — clear buffer
        ecInputBufferRef.current = '';
      }
      // Multi-byte sequences (arrow keys \x1b[A, etc.) are ignored — don't clear buffer

      // Pass everything through to PTY
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

    // Focus terminal (deferred so the container has layout before xterm tries to focus)
    requestAnimationFrame(() => term.focus());

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
      if (easyccNotificationTimerRef.current) {
        clearTimeout(easyccNotificationTimerRef.current);
        easyccNotificationTimerRef.current = null;
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
      promptNavIndexRef.current = null;
      searchAddonRef.current?.clearDecorations();
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
    term.options.scrollback = terminalSettings.scrollback;

    // Refit terminal after font changes
    if (fitAddonRef.current) {
      fitAddonRef.current.fit();
    }
  }, [terminalSettings.fontSize, terminalSettings.fontFamily, terminalSettings.cursorStyle, terminalSettings.cursorBlink, terminalSettings.scrollback]);

  // Update terminal theme when app theme changes
  useEffect(() => {
    if (!xtermRef.current) return;
    const effectiveTheme = getEffectiveTheme(settings?.ui?.theme);
    xtermRef.current.options.theme = TERMINAL_THEMES[effectiveTheme] || TERMINAL_THEMES.midnight;
  }, [settings?.ui?.theme]);

  // Keep promptHistoryRef in sync (avoids re-registering keydown on every prompt)
  useEffect(() => {
    promptHistoryRef.current = session?.promptHistory || [];
  }, [session?.promptHistory]);

  const scrollToLastPrompt = useCallback(() => {
    if (!xtermRef.current || !searchAddonRef.current) return;

    const history = promptHistoryRef.current;
    if (history.length === 0) {
      xtermRef.current.scrollToBottom();
      return;
    }

    const latestPrompt = history[history.length - 1].text;
    const searchTerm = sanitizeSearchTerm(latestPrompt);
    if (!searchTerm) {
      xtermRef.current.scrollToBottom();
      return;
    }

    searchAddonRef.current.clearDecorations();
    xtermRef.current.scrollToBottom();

    requestAnimationFrame(() => {
      const found = searchAddonRef.current.findPrevious(searchTerm, {
        regex: false,
        caseSensitive: true,
        decorations: {
          matchBackground: '#44444400',
          activeMatchBackground: '#665500',
          activeMatchColorOverviewRuler: '#ffaa00'
        }
      });
      if (!found) {
        xtermRef.current.scrollToBottom();
      }
      promptNavIndexRef.current = history.length - 1;
    });
  }, []);

  // Handle custom keyboard shortcuts
  useEffect(() => {
    if (!terminalRef.current) return;

    const handleKeyDown = (event) => {
      // Ctrl+=/+/-: Terminal font size zoom
      if (event.ctrlKey && !event.altKey && !event.metaKey && onUpdateSettings) {
        if (event.key === '=' || event.key === '+' || event.code === 'NumpadAdd') {
          event.preventDefault();
          const current = terminalSettings.fontSize;
          if (current < 32) {
            onUpdateSettings({ terminal: { fontSize: current + 1 } });
          }
          return;
        }
        if (event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract') {
          event.preventDefault();
          const current = terminalSettings.fontSize;
          if (current > 8) {
            onUpdateSettings({ terminal: { fontSize: current - 1 } });
          }
          return;
        }
        if (event.key === '0' && !event.shiftKey) {
          event.preventDefault();
          onUpdateSettings({ terminal: { fontSize: 14 } });
          return;
        }
      }

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

      // Check for clear shortcut
      if (matchKeyCombo(event, keyboardSettings.clearKey)) {
        event.preventDefault();
        xtermRef.current?.clear();
        return;
      }

      // cancelKey is handled by xterm's custom key handler (for confirmation).
    };

    const terminalElement = terminalRef.current;
    terminalElement.addEventListener('keydown', handleKeyDown);

    return () => {
      terminalElement.removeEventListener('keydown', handleKeyDown);
    };
  }, [keyboardSettings.copyKey, keyboardSettings.pasteKey, keyboardSettings.clearKey, scrollToLastPrompt, onUpdateSettings, terminalSettings.fontSize]);

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

  const handleStartFresh = () => {
    onResumeSession?.(session.id, { fresh: true });
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

  // Compute filtered & grouped session list for @ picker
  const { pickerItems, pickerSelectableSessions } = useMemo(() => {
    if (atPicker === null) return { pickerItems: [], pickerSelectableSessions: [] };
    const filtered = (sessions || [])
      .filter(s => s.id !== session?.id && s.status !== 'completed')
      .filter(s => !atPicker.query || s.name?.toLowerCase().includes(atPicker.query.toLowerCase()));

    // Group by team
    const myTeamId = session?.teamInstanceId || null;
    const myTeam = [];
    const otherTeams = new Map(); // teamInstanceId -> sessions[]
    const ungrouped = [];

    for (const s of filtered) {
      if (s.teamInstanceId) {
        if (s.teamInstanceId === myTeamId) {
          myTeam.push(s);
        } else {
          if (!otherTeams.has(s.teamInstanceId)) otherTeams.set(s.teamInstanceId, []);
          otherTeams.get(s.teamInstanceId).push(s);
        }
      } else {
        ungrouped.push(s);
      }
    }

    // Sort: orchestrators first within each group
    const sortGroup = (arr) => arr.sort((a, b) => (b.isOrchestrator ? 1 : 0) - (a.isOrchestrator ? 1 : 0));
    sortGroup(myTeam);
    sortGroup(ungrouped);

    // Build items list with headers
    const items = [];
    const selectable = [];
    if (myTeam.length > 0) {
      items.push({ type: 'header', label: 'My Team' });
      for (const s of myTeam) { items.push({ type: 'session', session: s }); selectable.push(s); }
    }
    for (const [, teamSessions] of otherTeams) {
      sortGroup(teamSessions);
      const orch = teamSessions.find(s => s.isOrchestrator);
      items.push({ type: 'header', label: orch ? orch.name : 'Team' });
      for (const s of teamSessions) { items.push({ type: 'session', session: s }); selectable.push(s); }
    }
    if (ungrouped.length > 0) {
      if (myTeam.length > 0 || otherTeams.size > 0) {
        items.push({ type: 'header', label: 'Other Sessions' });
      }
      for (const s of ungrouped) { items.push({ type: 'session', session: s }); selectable.push(s); }
    }

    return { pickerItems: items, pickerSelectableSessions: selectable.slice(0, 12) };
  }, [atPicker, sessions, session?.id, session?.teamInstanceId]);

  // Rebuild items capped to selectable limit
  const cappedPickerItems = useMemo(() => {
    if (pickerSelectableSessions.length === 0) return [];
    const selectableSet = new Set(pickerSelectableSessions.map(s => s.id));
    const items = [];
    let lastHeader = null;
    for (const item of pickerItems) {
      if (item.type === 'header') { lastHeader = item; continue; }
      if (selectableSet.has(item.session.id)) {
        if (lastHeader) { items.push(lastHeader); lastHeader = null; }
        items.push(item);
      }
    }
    return items;
  }, [pickerItems, pickerSelectableSessions]);

  const clampedPickerIndex = Math.min(atPicker?.selectedIndex ?? 0, Math.max(0, pickerSelectableSessions.length - 1));
  // Update select ref so the xterm Enter handler can trigger selection
  atPickerSelectRef.current = pickerSelectableSessions.length > 0
    ? () => handleAtPickerSelect(pickerSelectableSessions[clampedPickerIndex]?.name, pickerSelectableSessions[clampedPickerIndex]?.id)
    : null;

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
                📂 {getProjectDisplayName(session.workingDir, settings?.projectAliases)}
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
              <p>Resume the previous session or start a new one</p>
              <div className="paused-actions">
                <button className="btn btn-primary" onClick={handleResume}>
                  Resume Session
                </button>
                <button className="btn btn-secondary" onClick={handleStartFresh}>
                  Start Fresh
                </button>
              </div>
            </div>
          </div>
        )}
        {ecResult && (
          <div className="ec-result-overlay" onClick={() => setEcResult(null)}>
            <div className="ec-result-overlay__header">
              <span>{ecResult.command}</span>
              <button className="ec-result-overlay__close" onClick={() => setEcResult(null)}>close</button>
            </div>
            <div className="ec-result-overlay__body">
              {ecResult.type === 'list' && ecResult.data.map(s => (
                <div key={s.id} className="ec-result-overlay__row">
                  <span className="ec-result-overlay__id">{s.id.substring(0, 6)}</span>
                  <span className="ec-result-overlay__name">
                    {s.isOrchestrator ? '\u2733 ' : ''}{s.name}
                  </span>
                  <span className={`ec-result-overlay__status status-${s.status}`}>{s.status}</span>
                </div>
              ))}
              {ecResult.type === 'read' && (
                <div>
                  <div style={{ color: 'rgba(100,160,255,0.9)', marginBottom: 4 }}>{ecResult.sessionName}</div>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 11 }}>{ecResult.data}</pre>
                </div>
              )}
              {ecResult.type === 'confirm' && (
                <div className="ec-result-overlay__confirm">{ecResult.message}</div>
              )}
              {ecResult.type === 'error' && (
                <div style={{ color: '#ff5555' }}>{ecResult.message}</div>
              )}
              {ecResult.type === 'info' && (
                <div>{ecResult.message}</div>
              )}
            </div>
          </div>
        )}
        {easyccNotification && (
          <div
            className="ec-result-overlay"
            style={ecResult ? { bottom: 120 } : undefined}
            onClick={() => setEasyccNotification(null)}
          >
            <div className="ec-result-overlay__header">
              <span>{easyccNotification.command}</span>
              <button className="ec-result-overlay__close" onClick={() => setEasyccNotification(null)}>close</button>
            </div>
            <div className="ec-result-overlay__body">
              <div>{easyccNotification.message}</div>
            </div>
          </div>
        )}
        {atPicker !== null && (
          <div className="at-picker">
            <div className="at-picker__header">
              @{atPicker.query || <span className="at-picker__hint"> type to filter</span>}
            </div>
            {pickerSelectableSessions.length === 0 ? (
              <div className="at-picker__empty">No sessions</div>
            ) : (() => {
              let selectableIdx = -1;
              return cappedPickerItems.map((item, i) => {
                if (item.type === 'header') {
                  return <div key={`hdr-${i}`} className="at-picker__group-header">{item.label}</div>;
                }
                selectableIdx++;
                const s = item.session;
                return (
                  <div
                    key={s.id}
                    className={`at-picker__item${selectableIdx === clampedPickerIndex ? ' at-picker__item--active' : ''}`}
                    onClick={() => handleAtPickerSelect(s.name, s.id)}
                  >
                    <span className={`status-indicator ${s.status}`} />
                    <span className="at-picker__name">
                      {s.isOrchestrator && <span className="at-picker__orch-badge">ORCH</span>}
                      {s.name}
                    </span>
                    <span className="at-picker__type">{s.cliType}</span>
                  </div>
                );
              });
            })()}
          </div>
        )}
      </div>
    </div>
  );
});

// getDirectoryName moved to utils/projectUtils.js

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
