import { useState, useEffect } from 'react';

function PlanViewer({ plan, compact = false, workingDir = null }) {
  const [versions, setVersions] = useState([]);
  const [currentVersionIndex, setCurrentVersionIndex] = useState(null);
  const [versionContent, setVersionContent] = useState(null);
  const [showDiff, setShowDiff] = useState(false);
  const [diff, setDiff] = useState(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedContentSet, setSavedContentSet] = useState(new Set());
  const [allExpanded, setAllExpanded] = useState(null); // null=default, true=all open, false=all closed
  const [currentIsSaved, setCurrentIsSaved] = useState(false);
  const [showSavedVersions, setShowSavedVersions] = useState(false);

  if (!plan) return null;
  const planPathQuery = plan.path ? `&planPath=${encodeURIComponent(plan.path)}` : '';

  // Fetch versions when plan changes
  useEffect(() => {
    const fetchVersions = async () => {
      try {
        const url = workingDir
          ? `/api/plans/${plan.filename}/versions?workingDir=${encodeURIComponent(workingDir)}${planPathQuery}`
          : `/api/plans/${plan.filename}/versions?planPath=${encodeURIComponent(plan.path || '')}`;
        const response = await fetch(url);
        if (response.ok) {
          const data = await response.json();
          setVersions(data.versions || []);
          setCurrentIsSaved(data.currentIsSaved || false);
          // Default to live/current view; users navigate to snapshots via Prev/Next
          setCurrentVersionIndex(null);
        }
      } catch (error) {
        console.error('Error fetching plan versions:', error);
      }
    };

    fetchVersions();
  }, [plan.filename, plan.modifiedAt, plan.path, workingDir, planPathQuery]);

  // Fetch version content when currentVersionIndex changes
  useEffect(() => {
    if (currentVersionIndex === null || currentVersionIndex < 0 || currentVersionIndex >= versions.length) {
      setVersionContent(null);
      setDiff(null);
      return;
    }

    const fetchVersionContent = async () => {
      setLoading(true);
      try {
        const version = versions[currentVersionIndex];
        const response = await fetch(
          `/api/plans/${plan.filename}/versions/${version.filename}?planPath=${encodeURIComponent(plan.path || '')}`
        );
        if (response.ok) {
          const data = await response.json();
          setVersionContent(data.content);

          // Fetch diff if showDiff is enabled and not viewing current version
          if (showDiff && currentVersionIndex > 0) {
            const prevVersion = versions[currentVersionIndex - 1];
            const diffResponse = await fetch(
              `/api/plans/${plan.filename}/diff?from=${version.filename}&to=${prevVersion.filename}&planPath=${encodeURIComponent(plan.path || '')}`
            );
            if (diffResponse.ok) {
              const diffData = await diffResponse.json();
              setDiff(diffData.diff);
            }
          } else {
            setDiff(null);
          }
        }
      } catch (error) {
        console.error('Error fetching version content:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchVersionContent();
  }, [currentVersionIndex, versions, plan.filename, plan.path, showDiff]);

  // Fetch saved plans content to detect "already saved" versions
  useEffect(() => {
    if (!workingDir) {
      setSavedContentSet(new Set());
      return;
    }

    const fetchSavedPlans = async () => {
      try {
        const response = await fetch(`/api/saved-plans?workingDir=${encodeURIComponent(workingDir)}`);
        if (response.ok) {
          const data = await response.json();
          const contentSet = new Set(
            (data.plans || []).map(p => p.content.trim())
          );
          setSavedContentSet(contentSet);
        }
      } catch (error) {
        console.error('Error fetching saved plans for save check:', error);
      }
    };

    fetchSavedPlans();
  }, [workingDir]);

  const handlePrevVersion = () => {
    if (currentVersionIndex === null) {
      // From "current" (live), go to latest version (index 0)
      if (versions.length > 0) setCurrentVersionIndex(0);
    } else if (currentVersionIndex < versions.length - 1) {
      setCurrentVersionIndex(currentVersionIndex + 1);
    }
  };

  const handleNextVersion = () => {
    if (currentVersionIndex !== null && currentVersionIndex > 0) {
      setCurrentVersionIndex(currentVersionIndex - 1);
    } else if (currentVersionIndex === 0) {
      // From latest version, go back to live/current
      setCurrentVersionIndex(null);
      setVersionContent(null);
      setDiff(null);
      setShowDiff(false);
    }
  };

  const handleCurrentVersion = () => {
    setCurrentVersionIndex(null);
    setVersionContent(null);
    setDiff(null);
    setShowDiff(false);
  };

  const handleToggleDiff = () => {
    setShowDiff(!showDiff);
  };

  const handleCopyPlan = async () => {
    const content = currentVersionIndex === null ? plan.content : versionContent;
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy plan:', err);
    }
  };

  const handleSavePlan = async () => {
    const content = currentVersionIndex === null ? plan.content : versionContent;
    if (!content || !workingDir) return;

    // Extract title from first h1
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1] : plan.name || 'plan';

    // Version info
    const versionNumber = currentVersionIndex === null
      ? null
      : versions.length - currentVersionIndex;
    const versionDate = currentVersionIndex !== null && versions[currentVersionIndex]
      ? versions[currentVersionIndex].savedAt || versions[currentVersionIndex].timestamp
      : null;

    try {
      const response = await fetch('/api/plans/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, title, versionNumber, versionDate, workingDir })
      });
      if (response.ok) {
        setSaved(true);
        setSavedContentSet(prev => new Set(prev).add(content.trim()));
        // Update dot strip: mark the current version/current as saved
        if (currentVersionIndex !== null) {
          setVersions(prev => prev.map((v, i) =>
            i === currentVersionIndex ? { ...v, isSaved: true } : v
          ));
        } else {
          setCurrentIsSaved(true);
        }
        setTimeout(() => setSaved(false), 2000);
      }
    } catch (err) {
      console.error('Failed to save plan:', err);
    }
  };

  const handleToggleExpandAll = () => {
    setAllExpanded(prev => prev === true ? false : true);
  };

  const handleSectionToggle = () => {
    // Reset bulk expand/collapse when user manually toggles a section
    setAllExpanded(null);
  };

  // Determine content to display
  const displayContent = currentVersionIndex === null ? plan.content : versionContent;
  const isViewingVersion = currentVersionIndex !== null;
  const canShowDiff = isViewingVersion && currentVersionIndex < versions.length - 1;
  const alreadySaved = displayContent ? savedContentSet.has(displayContent.trim()) : false;

  return (
    <div className={`plan-viewer ${compact ? 'compact' : ''}`}>
      {/* Version navigation bar */}
      {versions.length > 0 && (
        <div className="plan-version-nav">
          <div className="version-nav-left">
            <button
              className="btn-small"
              onClick={handlePrevVersion}
              disabled={isViewingVersion && currentVersionIndex >= versions.length - 1}
              title="Previous version (older)"
            >
              ◀ Prev
            </button>
            <button
              className="btn-small"
              onClick={handleNextVersion}
              disabled={!isViewingVersion}
              title="Next version (newer)"
            >
              Next ▶
            </button>
            <button
              className="btn-small btn-primary"
              onClick={handleCurrentVersion}
              disabled={!isViewingVersion}
              title="Jump to current version"
            >
              Current
            </button>
            {workingDir && (
              <>
                <button
                  className={`btn-small ${(saved || alreadySaved) ? 'btn-saved' : ''}`}
                  onClick={handleSavePlan}
                  disabled={!displayContent || saved || alreadySaved}
                  title={alreadySaved ? 'This version is already saved' : 'Save this version to project plans'}
                >
                  {(saved || alreadySaved) ? '\u2713 Saved' : '\uD83D\uDCBE Save'}
                </button>
                <button
                  className="btn-small"
                  onClick={() => setShowSavedVersions(true)}
                  title="View all saved versions of this plan"
                >
                  {'\uD83D\uDCCB'}
                </button>
              </>
            )}
          </div>

          <div className="version-nav-center">
            {isViewingVersion ? (
              <span className="version-indicator">
                Version {versions.length - currentVersionIndex} of {versions.length}
                {versions[currentVersionIndex] && (
                  <span className="version-date">
                    {' • '}
                    {formatDate(versions[currentVersionIndex].savedAt || versions[currentVersionIndex].timestamp)}
                  </span>
                )}
              </span>
            ) : (
              <span className="version-indicator">
                Current • {versions.length} version{versions.length !== 1 ? 's' : ''}
              </span>
            )}
            {versions.length > 0 && (
              <div className="version-dots">
                {[...versions].reverse().map((v, reverseIdx) => {
                  const vIdx = versions.length - 1 - reverseIdx;
                  const isViewing = currentVersionIndex === vIdx;
                  return (
                    <span
                      key={v.filename}
                      className={`version-dot${v.isSaved ? ' saved' : ''}${isViewing ? ' viewing' : ''}`}
                      onClick={() => setCurrentVersionIndex(vIdx)}
                      title={`v${reverseIdx + 1}${v.isSaved ? ' (saved)' : ''} \u2014 ${formatDate(v.savedAt || v.timestamp)}`}
                    />
                  );
                })}
                <span
                  className={`version-dot current-dot${currentIsSaved ? ' saved' : ''}${currentVersionIndex === null ? ' viewing' : ''}`}
                  onClick={handleCurrentVersion}
                  title={`Current${currentIsSaved ? ' (saved)' : ''}`}
                />
              </div>
            )}
          </div>

          <div className="version-nav-right">
            <button
              className="btn-small"
              onClick={handleToggleExpandAll}
              title={allExpanded ? 'Collapse all sections' : 'Expand all sections'}
            >
              {allExpanded ? '\u229F Collapse' : '\u229E Expand'}
            </button>
            {canShowDiff && (
              <button
                className={`btn-small ${showDiff ? 'btn-active' : ''}`}
                onClick={handleToggleDiff}
                title={showDiff ? 'Hide diff' : 'Show diff'}
              >
                {showDiff ? '\u2713 ' : ''}Diff
              </button>
            )}
          </div>
        </div>
      )}

      {/* Expand/Collapse when no version nav */}
      {versions.length === 0 && (
        <div className="plan-actions-bar">
          {workingDir && (
            <>
              <button
                className={`btn-small ${(saved || alreadySaved) ? 'btn-saved' : ''}`}
                onClick={handleSavePlan}
                disabled={!displayContent || saved || alreadySaved}
                title={alreadySaved ? 'This version is already saved' : 'Save this version to project plans'}
              >
                {(saved || alreadySaved) ? '\u2713 Saved' : '\uD83D\uDCBE Save'}
              </button>
              <button
                className="btn-small"
                onClick={() => setShowSavedVersions(true)}
                title="View all saved versions of this plan"
              >
                {'\uD83D\uDCCB'}
              </button>
            </>
          )}
          <button
            className="btn-small"
            onClick={handleToggleExpandAll}
            title={allExpanded ? 'Collapse all sections' : 'Expand all sections'}
          >
            {allExpanded ? '\u229F Collapse' : '\u229E Expand'}
          </button>
        </div>
      )}

      {/* Content area */}
      <div className="plan-content">
        {loading ? (
          <div className="plan-loading">Loading...</div>
        ) : showDiff && diff ? (
          <DiffViewer diff={diff} compact={compact} />
        ) : (
          <MarkdownRenderer
            content={displayContent}
            compact={compact}
            onCopy={handleCopyPlan}
            copied={copied}
            forceExpanded={allExpanded}
            onSectionToggle={handleSectionToggle}
          />
        )}
      </div>

      {showSavedVersions && workingDir && (
        <SavedVersionsModal
          planFilename={plan.filename}
          planPath={plan.path}
          workingDir={workingDir}
          onClose={() => setShowSavedVersions(false)}
        />
      )}
    </div>
  );
}

function SavedVersionsModal({ planFilename, planPath, workingDir, onClose }) {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedPlan, setExpandedPlan] = useState(null);
  const [copiedPath, setCopiedPath] = useState(null);

  useEffect(() => {
    const planPathParam = planPath ? `&planPath=${encodeURIComponent(planPath)}` : '';
    fetch(`/api/saved-plans?workingDir=${encodeURIComponent(workingDir)}&planFile=${encodeURIComponent(planFilename)}${planPathParam}`)
      .then(r => r.json())
      .then(data => { setPlans(data.plans || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [workingDir, planFilename, planPath]);

  const handleCopyPath = async (planPath, e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(planPath);
      setCopiedPath(planPath);
      setTimeout(() => setCopiedPath(null), 2000);
    } catch { /* silent */ }
  };

  const handleOpenInEditor = async (planPath, e) => {
    e.stopPropagation();
    try {
      await fetch('/api/open-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: planPath })
      });
    } catch { /* silent */ }
  };

  const handleDelete = async (plan) => {
    if (!window.confirm(`Delete "${plan.filename}"?`)) return;
    try {
      const res = await fetch(`/api/saved-plans?path=${encodeURIComponent(plan.path)}`, { method: 'DELETE' });
      if (res.ok) {
        setPlans(prev => prev.filter(p => p.path !== plan.path));
        if (expandedPlan === plan.path) setExpandedPlan(null);
      }
    } catch { /* silent */ }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal saved-versions-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Saved Versions</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="saved-plans-body">
          {loading ? (
            <div className="folder-loading">Loading...</div>
          ) : plans.length === 0 ? (
            <div className="folder-empty">No saved versions for this plan</div>
          ) : (
            <div className="saved-plans-list">
              {plans.map(p => (
                <div key={p.path} className={`saved-plan-item ${expandedPlan === p.path ? 'expanded' : ''}`}>
                  <div
                    className="saved-plan-header"
                    onClick={() => setExpandedPlan(expandedPlan === p.path ? null : p.path)}
                  >
                    <span className="expand-icon">{expandedPlan === p.path ? '\u25BC' : '\u25B6'}</span>
                    <div className="saved-plan-info">
                      <span className="saved-plan-name">{p.name}</span>
                      <span className="saved-plan-filename">{p.filename}</span>
                    </div>
                    <span className="saved-plan-date">{formatDate(p.modifiedAt)}</span>
                    <div className="saved-plan-actions">
                      <button
                        className="btn-icon"
                        onClick={(e) => handleCopyPath(p.path, e)}
                        title="Copy file path"
                      >
                        {copiedPath === p.path ? '\u2713' : '\uD83D\uDCCB'}
                      </button>
                      <button
                        className="btn-icon"
                        onClick={(e) => handleOpenInEditor(p.path, e)}
                        title="Open in editor"
                      >
                        {'\uD83D\uDCDD'}
                      </button>
                      <button
                        className="btn-icon btn-icon-danger"
                        onClick={(e) => { e.stopPropagation(); handleDelete(p); }}
                        title="Delete"
                      >
                        &times;
                      </button>
                    </div>
                  </div>
                  {expandedPlan === p.path && (
                    <div className="saved-plan-content">
                      <PlanViewer plan={p} compact={true} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MarkdownRenderer({ content, compact = false, onCopy, copied, forceExpanded, onSectionToggle }) {
  if (!content) return <p className="text-muted">No content available</p>;

  const compactClass = compact ? 'compact' : '';

  // Parse content into sections based on headings
  const sections = parseIntoSections(content);

  return (
    <div className={`markdown-content ${compactClass}`}>
      {sections.map((section, idx) => (
        <MarkdownSection
          key={idx}
          section={section}
          onCopy={onCopy}
          copied={copied}
          forceExpanded={forceExpanded}
          onSectionToggle={onSectionToggle}
        />
      ))}
    </div>
  );
}

/**
 * Parse markdown content into a tree of sections based on heading levels.
 * Each section has: { level, title, lineIndex, contentLines, children }
 * level 0 = preamble (content before any heading)
 */
function parseIntoSections(content) {
  // First check if content has any markdown headings
  const hasMarkdownHeadings = /^\s*#{1,6}\s+/m.test(content);

  if (hasMarkdownHeadings) {
    const sections = parseMarkdownSections(content);
    applyNumberedSubsections(sections);
    return sections;
  }

  // Fallback: detect plain text sections (Codex format)
  const sections = parsePlainTextSections(content);
  applyNumberedSubsections(sections);
  return sections;
}

/**
 * Parse markdown content with # headings
 */
function parseMarkdownSections(content) {
  const lines = content.split('\n');
  const root = [];
  const stack = [{ level: 0, children: root }];

  let currentLines = [];
  let currentTitle = null;
  let currentLevel = 0;
  let currentLineIndex = 0;

  const flushSection = () => {
    if (currentTitle !== null || currentLines.length > 0) {
      const section = {
        level: currentLevel,
        title: currentTitle,
        lineIndex: currentLineIndex,
        contentLines: [...currentLines],
        children: []
      };

      while (stack.length > 1 && stack[stack.length - 1].level >= currentLevel) {
        stack.pop();
      }
      stack[stack.length - 1].children.push(section);
      stack.push(section);
    }
    currentLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trimStart();
    const headingMatch = trimmedLine.match(/^(#{1,6})\s+(.+)/);

    if (headingMatch) {
      flushSection();
      currentLevel = headingMatch[1].length;
      currentTitle = headingMatch[2];
      currentLineIndex = i;
    } else {
      currentLines.push(line);
    }
  }
  flushSection();

  return root;
}

/**
 * Detect plain text section headers (Codex/generic format).
 * A section header is a non-empty line that:
 * - Is short (< 60 chars)
 * - Does NOT start with a number, bullet, or whitespace
 * - Is followed by a blank line or indented/list content
 * - Contains mostly letters (Title Case or ALL CAPS)
 */
function isPlainTextHeading(line, nextLine) {
  if (!line || line.length > 60) return false;
  // Skip lines starting with bullets, numbers, whitespace
  if (/^[\s\-*+\d]/.test(line)) return false;
  // Skip lines that look like content (contain lots of punctuation or lowercase-heavy)
  if (/[.;,!?]{2,}/.test(line)) return false;
  // Must look like a title: mostly words, maybe with / or & or :
  if (!/^[A-Za-z][\w\s/&:()\-]*$/.test(line.trim())) return false;
  // Next line should be blank, indented, a list item, or a numbered item
  if (nextLine !== undefined) {
    const nl = nextLine.trim();
    if (nl === '' || /^[-*+\d]/.test(nl) || nextLine.startsWith('  ')) return true;
  }
  return true;
}

function parsePlainTextSections(content) {
  const lines = content.split('\n');
  const root = [];
  const stack = [{ level: 0, children: root }];

  let currentLines = [];
  let currentTitle = null;
  let currentLevel = 0;
  let currentLineIndex = 0;

  const flushSection = () => {
    if (currentTitle !== null || currentLines.length > 0) {
      const section = {
        level: currentLevel,
        title: currentTitle,
        lineIndex: currentLineIndex,
        contentLines: [...currentLines],
        children: []
      };

      while (stack.length > 1 && stack[stack.length - 1].level >= currentLevel) {
        stack.pop();
      }
      stack[stack.length - 1].children.push(section);
      stack.push(section);
    }
    currentLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;

    if (isPlainTextHeading(line, nextLine)) {
      flushSection();
      // First heading = h1, rest = h2
      currentLevel = root.length === 0 && currentTitle === null ? 1 : 2;
      currentTitle = line.trim();
      currentLineIndex = i;
    } else {
      currentLines.push(line);
    }
  }
  flushSection();

  return root;
}

/**
 * Post-process sections: split top-level numbered items into collapsible subsections.
 * e.g. "1. Foo\n  - bar\n  - baz\n2. Qux\n  - quux" becomes two child sections.
 */
function splitNumberedSubsections(section) {
  if (!section.contentLines.length) return;

  const groups = [];
  let currentGroup = null;
  let preambleLines = [];

  for (const line of section.contentLines) {
    const numMatch = line.match(/^(\d+)\.\s+(.+)/);
    if (numMatch) {
      if (currentGroup) groups.push(currentGroup);
      currentGroup = { title: `${numMatch[1]}. ${numMatch[2]}`, lines: [] };
    } else if (currentGroup) {
      currentGroup.lines.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  if (currentGroup) groups.push(currentGroup);

  // Only convert if we found 2+ numbered items
  if (groups.length < 2) return;

  section.contentLines = preambleLines;
  const numberedChildren = groups.map(group => ({
    level: section.level + 1,
    title: group.title,
    lineIndex: section.lineIndex,
    contentLines: group.lines,
    children: []
  }));
  // Prepend numbered children before any existing heading-based children
  section.children = [...numberedChildren, ...section.children];
}

/** Recursively apply splitNumberedSubsections to a tree of sections */
function applyNumberedSubsections(sections) {
  for (const section of sections) {
    splitNumberedSubsections(section);
    if (section.children.length) {
      applyNumberedSubsections(section.children);
    }
  }
}

function MarkdownSection({ section, onCopy, copied, forceExpanded, onSectionToggle }) {
  // Auto-collapse rules:
  // - level >= 3 (### and deeper) collapsed by default
  // - Special section titles that should collapse regardless of level
  // Auto-collapse keywords based on analysis of 100+ actual Claude plans
  const autoCollapseTitles = [
    'files to modify',
    'file to modify',
    'files to create',
    'files to create/modify',
    'files summary',
    'file summary',
    'critical files',
    'implementation plan',
    'implementation steps',
    'implementation order',
    'implementation',
    'changes',
    'summary of changes',
    'prerequisites',
    'dependencies'
  ];

  const titleLower = (section.title || '').toLowerCase();
  const shouldAutoCollapse = section.level >= 3 ||
    (section.title && autoCollapseTitles.some(t => titleLower === t || titleLower.startsWith(t + ' ')));

  const [collapsed, setCollapsed] = useState(shouldAutoCollapse);

  // forceExpanded overrides local collapsed state
  const isCollapsed = forceExpanded !== null && forceExpanded !== undefined
    ? !forceExpanded
    : collapsed;

  const hasContent = section.contentLines.length > 0 || section.children.length > 0;
  const isCollapsible = section.title && hasContent;

  const HeadingTag = section.level === 1 ? 'h1' : section.level === 2 ? 'h2' : 'h3';
  const headingClass = `md-h${Math.min(section.level, 3)}`;

  const handleHeadingClick = () => {
    if (isCollapsible) {
      setCollapsed(!collapsed);
      onSectionToggle?.(); // Reset bulk expand/collapse
    }
  };

  return (
    <div className={`md-section md-section-level-${section.level}`}>
      {section.title && (
        <div
          className={`md-section-heading ${isCollapsible ? 'collapsible' : ''}`}
          onClick={handleHeadingClick}
        >
          {isCollapsible && (
            <span className="md-section-toggle">{isCollapsed ? '\u25B6' : '\u25BC'}</span>
          )}
          <HeadingTag className={headingClass}>
            {section.title}
            {section.level === 1 && onCopy && (
              <button
                className="btn-icon plan-copy-btn"
                onClick={(e) => { e.stopPropagation(); onCopy(); }}
                title="Copy plan to clipboard"
              >
                {copied ? '\u2713' : '\uD83D\uDCCB'}
              </button>
            )}
          </HeadingTag>
        </div>
      )}
      {(!isCollapsible || !isCollapsed) && (
        <div className="md-section-body">
          {section.contentLines.length > 0 && (
            <RawLines lines={section.contentLines} startIndex={section.lineIndex} />
          )}
          {section.children.map((child, idx) => (
            <MarkdownSection
              key={idx}
              section={child}
              forceExpanded={forceExpanded}
              onSectionToggle={onSectionToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Render raw markdown lines (non-heading content) into elements
 */
function RawLines({ lines, startIndex = 0 }) {
  const elements = [];
  let inCodeBlock = false;
  let codeBlockLines = [];
  let codeBlockLang = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const key = `${startIndex}-${i}`;

    if (line.startsWith('```')) {
      if (inCodeBlock) {
        elements.push(
          <pre key={`code-${key}`} className="code-block">
            <code className={codeBlockLang ? `language-${codeBlockLang}` : ''}>
              {codeBlockLines.join('\n')}
            </code>
          </pre>
        );
        codeBlockLines = [];
        codeBlockLang = '';
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    if (line.match(/^(-{3,}|_{3,}|\*{3,})$/)) {
      elements.push(<hr key={key} className="md-hr" />);
      continue;
    }

    if (line.match(/^\s*[-*+]\s/)) {
      const indent = line.match(/^\s*/)[0].length;
      const text = line.replace(/^\s*[-*+]\s/, '');
      elements.push(
        <div key={key} className="md-list-item" style={{ paddingLeft: `${indent * 10 + 16}px` }}>
          <span className="list-bullet">{'\u2022'}</span>
          {renderInlineFormatting(text)}
        </div>
      );
      continue;
    }

    const orderedMatch = line.match(/^\s*(\d+)\.\s/);
    if (orderedMatch) {
      const indent = line.match(/^\s*/)[0].length;
      const text = line.replace(/^\s*\d+\.\s/, '');
      elements.push(
        <div key={key} className="md-list-item" style={{ paddingLeft: `${indent * 10 + 16}px` }}>
          <span className="list-number">{orderedMatch[1]}.</span>
          {renderInlineFormatting(text)}
        </div>
      );
      continue;
    }

    if (line.startsWith('>')) {
      elements.push(
        <blockquote key={key} className="md-blockquote">
          {renderInlineFormatting(line.slice(1).trim())}
        </blockquote>
      );
      continue;
    }

    if (line.includes('|')) {
      elements.push(
        <div key={key} className="md-table-row">
          {line.split('|').filter(Boolean).map((cell, j) => (
            <span key={j} className="md-table-cell">{cell.trim()}</span>
          ))}
        </div>
      );
      continue;
    }

    if (line.trim() === '') {
      elements.push(<div key={key} className="md-spacer" />);
      continue;
    }

    elements.push(
      <p key={key} className="md-paragraph">{renderInlineFormatting(line)}</p>
    );
  }

  return <>{elements}</>;
}

function renderInlineFormatting(text) {
  if (!text) return null;

  // Replace inline code
  const parts = [];
  let remaining = text;
  let key = 0;

  while (remaining) {
    // Check for inline code
    const codeMatch = remaining.match(/`([^`]+)`/);
    if (codeMatch) {
      const before = remaining.slice(0, codeMatch.index);
      if (before) {
        parts.push(<span key={key++}>{formatTextStyles(before)}</span>);
      }
      parts.push(<code key={key++} className="inline-code">{codeMatch[1]}</code>);
      remaining = remaining.slice(codeMatch.index + codeMatch[0].length);
    } else {
      parts.push(<span key={key++}>{formatTextStyles(remaining)}</span>);
      break;
    }
  }

  return parts;
}

function formatTextStyles(text) {
  if (!text) return null;

  // Handle bold (**text**)
  text = text.replace(/\*\*([^*]+)\*\*/g, '##BOLD_START##$1##BOLD_END##');
  // Handle italic (*text*)
  text = text.replace(/\*([^*]+)\*/g, '##ITALIC_START##$1##ITALIC_END##');

  const parts = text.split(/(##BOLD_START##|##BOLD_END##|##ITALIC_START##|##ITALIC_END##)/);
  const result = [];
  let isBold = false;
  let isItalic = false;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '##BOLD_START##') {
      isBold = true;
    } else if (part === '##BOLD_END##') {
      isBold = false;
    } else if (part === '##ITALIC_START##') {
      isItalic = true;
    } else if (part === '##ITALIC_END##') {
      isItalic = false;
    } else if (part) {
      if (isBold && isItalic) {
        result.push(<strong key={i}><em>{part}</em></strong>);
      } else if (isBold) {
        result.push(<strong key={i}>{part}</strong>);
      } else if (isItalic) {
        result.push(<em key={i}>{part}</em>);
      } else {
        result.push(part);
      }
    }
  }

  return result;
}

function formatDate(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function DiffViewer({ diff, compact = false }) {
  if (!diff || !Array.isArray(diff)) {
    return <p className="text-muted">No diff available</p>;
  }

  const compactClass = compact ? 'compact' : '';

  return (
    <div className={`diff-viewer ${compactClass}`}>
      {diff.map((item, index) => {
        const { type, line, lineNumber } = item;

        let className = 'diff-line';
        let prefix = ' ';

        switch (type) {
          case 'add':
            className += ' diff-line-added';
            prefix = '+';
            break;
          case 'delete':
            className += ' diff-line-deleted';
            prefix = '-';
            break;
          case 'same':
            className += ' diff-line-same';
            break;
          default:
            break;
        }

        return (
          <div key={index} className={className}>
            <span className="diff-line-number">{lineNumber}</span>
            <span className="diff-line-prefix">{prefix}</span>
            <span className="diff-line-content">{line}</span>
          </div>
        );
      })}
    </div>
  );
}

export default PlanViewer;
