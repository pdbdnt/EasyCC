import { useEffect } from 'react';
import { registerHint, unregisterHint } from '../utils/hintRegistry';

/**
 * HintBadge - Visual hint badge component for keyboard navigation
 *
 * @param {object} props
 * @param {string} props.code - The hint code to display (e.g., 's1', 'ns')
 * @param {boolean} props.visible - Whether the badge is visible
 * @param {string} [props.position='top-left'] - Position: 'top-left', 'top-right', 'inline', 'bottom-left', 'bottom-right'
 * @param {function} [props.action] - Action to execute when hint is triggered
 * @param {string} [props.typedChars=''] - Currently typed characters (for partial match highlighting)
 * @param {string} [props.className=''] - Additional CSS classes
 */
function HintBadge({
  code,
  visible,
  position = 'top-left',
  action,
  typedChars = '',
  className = ''
}) {
  // Register/unregister hint when action changes
  useEffect(() => {
    if (action && code) {
      registerHint(code, { action });
      return () => unregisterHint(code);
    }
  }, [code, action]);

  if (!visible || !code) return null;

  // Check if current typed chars partially match this hint
  const normalizedCode = code.toLowerCase();
  const normalizedTyped = typedChars.toLowerCase();
  const isPartialMatch = normalizedTyped.length > 0 &&
    normalizedCode.startsWith(normalizedTyped) &&
    normalizedTyped.length < normalizedCode.length;
  const isExactMatch = normalizedTyped === normalizedCode;

  // Split code into matched and unmatched parts for highlighting
  const matchedPart = isPartialMatch ? normalizedCode.slice(0, normalizedTyped.length) : '';
  const unmatchedPart = isPartialMatch ? normalizedCode.slice(normalizedTyped.length) : normalizedCode;

  const badgeClasses = [
    'hint-badge',
    `hint-badge-${position}`,
    isPartialMatch && 'partial-match',
    isExactMatch && 'exact-match',
    className
  ].filter(Boolean).join(' ');

  return (
    <span className={badgeClasses}>
      {isPartialMatch ? (
        <>
          <span className="hint-matched">{matchedPart}</span>
          <span className="hint-unmatched">{unmatchedPart}</span>
        </>
      ) : (
        code
      )}
    </span>
  );
}

export default HintBadge;
