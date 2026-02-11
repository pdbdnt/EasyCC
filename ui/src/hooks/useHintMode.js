import { useState, useEffect, useCallback, useRef } from 'react';
import { hasExactMatch, hasPotentialMatch, executeHint } from '../utils/hintRegistry';

/**
 * Hook for Vimium-style keyboard hint mode
 * Tap trigger key(s) to activate sticky mode, type hint codes, ESC or match to deactivate
 *
 * @param {object} options - Configuration options
 * @param {boolean} options.enabled - Whether hint mode is enabled
 * @param {string} options.triggerKey - The key to tap (default: 'Ctrl+Alt')
 * @returns {object} Hint mode state and controls
 */
export function useHintMode(options = {}) {
  const { enabled = true, triggerKey = 'Ctrl+Alt' } = options;

  const [isActive, setIsActive] = useState(false);
  const [typedChars, setTypedChars] = useState('');
  const [lastMatchedHint, setLastMatchedHint] = useState(null);

  // Refs for reading current values inside event handlers without causing listener churn
  const isActiveRef = useRef(false);
  const typedCharsRef = useRef('');

  // Sync refs during render
  isActiveRef.current = isActive;
  typedCharsRef.current = typedChars;

  // Track key state for tap detection
  const keyStateRef = useRef({
    ctrlPressed: false,
    altPressed: false,
    activatedThisCombo: false
  });

  // Track previously focused element to restore on cancel
  const previousFocusRef = useRef(null);

  // Reset typed chars when hint mode is activated
  const activate = useCallback(() => {
    // Save current focus before activating
    previousFocusRef.current = document.activeElement;
    setIsActive(true);
    setTypedChars('');
    setLastMatchedHint(null);
    // Update refs immediately so handlers see current state
    isActiveRef.current = true;
    typedCharsRef.current = '';
  }, []);

  const deactivate = useCallback((restoreFocus = false) => {
    setIsActive(false);
    setTypedChars('');
    setLastMatchedHint(null);
    // Update refs immediately so handlers see current state
    isActiveRef.current = false;
    typedCharsRef.current = '';

    // Restore previous focus if requested (on cancel, not on successful match)
    if (restoreFocus && previousFocusRef.current) {
      previousFocusRef.current.focus();
    }
    previousFocusRef.current = null;
  }, []);

  const clearTyped = useCallback(() => {
    setTypedChars('');
    typedCharsRef.current = '';
  }, []);

  useEffect(() => {
    if (!enabled) {
      setIsActive(false);
      isActiveRef.current = false;
      return;
    }

    const handleKeyDown = (e) => {
      // Handle Ctrl+Alt combo trigger
      if (triggerKey === 'Ctrl+Alt') {
        if (e.key === 'Control') {
          keyStateRef.current.ctrlPressed = true;
        }
        if (e.key === 'Alt') {
          keyStateRef.current.altPressed = true;
        }

        // If both are pressed and we haven't activated yet, activate
        if (keyStateRef.current.ctrlPressed && keyStateRef.current.altPressed && !isActiveRef.current && !keyStateRef.current.activatedThisCombo) {
          keyStateRef.current.activatedThisCombo = true;
          activate();
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
      // Handle backtick trigger (special case - single character key)
      else if (triggerKey === '`' || triggerKey === 'Backquote') {
        if (e.key === '`' && !e.ctrlKey && !e.altKey && !e.metaKey) {
          if (isActiveRef.current) {
            // Toggle off - restore previous focus
            deactivate(true);
          } else {
            activate();
          }
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          return;
        }
      }
      // Handle modifier key triggers (Alt, Ctrl, Shift, Meta)
      else {
        const keyMap = {
          'Alt': 'Alt',
          'Ctrl': 'Control',
          'Control': 'Control',
          'Shift': 'Shift',
          'Meta': 'Meta'
        };
        const expectedKey = keyMap[triggerKey] || triggerKey;

        if (e.key === expectedKey && !isActiveRef.current) {
          activate();
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      // If hint mode is active (sticky mode), handle typed characters
      if (isActiveRef.current) {
        // Block ALL keys from reaching the terminal while in hint mode
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        // Don't process modifier keys themselves
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
          return;
        }

        // Escape cancels hint mode and restores previous focus
        if (e.key === 'Escape') {
          deactivate(true);
          return;
        }

        // Backspace removes last character
        if (e.key === 'Backspace') {
          const newTyped = typedCharsRef.current.slice(0, -1);
          setTypedChars(newTyped);
          typedCharsRef.current = newTyped;
          return;
        }

        // Only accept alphanumeric characters
        if (/^[a-zA-Z0-9]$/.test(e.key)) {
          const newTyped = typedCharsRef.current + e.key.toLowerCase();
          setTypedChars(newTyped);
          typedCharsRef.current = newTyped;

          // Check for exact match → execute and deactivate (don't restore focus, hint handles it)
          if (hasExactMatch(newTyped)) {
            const executed = executeHint(newTyped);
            if (executed) {
              setLastMatchedHint(newTyped);
            }
            deactivate(false);
          }
          // Check if no possible matches → deactivate and restore focus
          else if (!hasPotentialMatch(newTyped)) {
            deactivate(true);
          }
        }
      }
    };

    const handleKeyUp = (e) => {
      // Track modifier key releases for Ctrl+Alt combo
      if (triggerKey === 'Ctrl+Alt') {
        if (e.key === 'Control') {
          keyStateRef.current.ctrlPressed = false;
        }
        if (e.key === 'Alt') {
          keyStateRef.current.altPressed = false;
        }

        // Reset activation flag when both keys are released
        if (!keyStateRef.current.ctrlPressed && !keyStateRef.current.altPressed) {
          keyStateRef.current.activatedThisCombo = false;
        }
      }
      // Note: In sticky mode, we don't deactivate on key release
    };

    // Deactivate if window loses focus (restore focus when window regains it)
    const handleBlur = () => {
      if (isActiveRef.current) {
        deactivate(true);
      }
      // Reset key state on blur
      keyStateRef.current.ctrlPressed = false;
      keyStateRef.current.altPressed = false;
      keyStateRef.current.activatedThisCombo = false;
    };

    // Use capture phase to intercept before terminal gets the key
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('blur', handleBlur);
    };
  }, [enabled, triggerKey, activate, deactivate]);

  return {
    isActive,
    typedChars,
    lastMatchedHint,
    setLastMatchedHint,
    clearTyped,
    activate,
    deactivate
  };
}

export default useHintMode;
