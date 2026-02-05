function PlanViewer({ plan, compact = false }) {
  if (!plan) return null;

  return (
    <div className={`plan-viewer ${compact ? 'compact' : ''}`}>
      <div className="plan-content">
        <MarkdownRenderer content={plan.content} compact={compact} />
      </div>
    </div>
  );
}

function MarkdownRenderer({ content, compact = false }) {
  if (!content) return <p className="text-muted">No content available</p>;

  // In compact mode, reduce spacing
  const compactClass = compact ? 'compact' : '';

  // Simple markdown rendering for display
  const lines = content.split('\n');
  const elements = [];
  let inCodeBlock = false;
  let codeBlockLines = [];
  let codeBlockLang = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Handle code blocks
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        elements.push(
          <pre key={`code-${i}`} className="code-block">
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

    // Handle headings
    if (line.startsWith('# ')) {
      elements.push(<h1 key={i} className="md-h1">{line.slice(2)}</h1>);
      continue;
    }
    if (line.startsWith('## ')) {
      elements.push(<h2 key={i} className="md-h2">{line.slice(3)}</h2>);
      continue;
    }
    if (line.startsWith('### ')) {
      elements.push(<h3 key={i} className="md-h3">{line.slice(4)}</h3>);
      continue;
    }

    // Handle horizontal rules
    if (line.match(/^(-{3,}|_{3,}|\*{3,})$/)) {
      elements.push(<hr key={i} className="md-hr" />);
      continue;
    }

    // Handle unordered lists
    if (line.match(/^\s*[-*+]\s/)) {
      const indent = line.match(/^\s*/)[0].length;
      const text = line.replace(/^\s*[-*+]\s/, '');
      elements.push(
        <div key={i} className="md-list-item" style={{ paddingLeft: `${indent * 10 + 16}px` }}>
          <span className="list-bullet">•</span>
          {renderInlineFormatting(text)}
        </div>
      );
      continue;
    }

    // Handle ordered lists
    const orderedMatch = line.match(/^\s*(\d+)\.\s/);
    if (orderedMatch) {
      const indent = line.match(/^\s*/)[0].length;
      const text = line.replace(/^\s*\d+\.\s/, '');
      elements.push(
        <div key={i} className="md-list-item" style={{ paddingLeft: `${indent * 10 + 16}px` }}>
          <span className="list-number">{orderedMatch[1]}.</span>
          {renderInlineFormatting(text)}
        </div>
      );
      continue;
    }

    // Handle blockquotes
    if (line.startsWith('>')) {
      elements.push(
        <blockquote key={i} className="md-blockquote">
          {renderInlineFormatting(line.slice(1).trim())}
        </blockquote>
      );
      continue;
    }

    // Handle tables (simple)
    if (line.includes('|')) {
      elements.push(
        <div key={i} className="md-table-row">
          {line.split('|').filter(Boolean).map((cell, j) => (
            <span key={j} className="md-table-cell">{cell.trim()}</span>
          ))}
        </div>
      );
      continue;
    }

    // Handle empty lines
    if (line.trim() === '') {
      elements.push(<div key={i} className="md-spacer" />);
      continue;
    }

    // Regular paragraph
    elements.push(
      <p key={i} className="md-paragraph">{renderInlineFormatting(line)}</p>
    );
  }

  return <div className={`markdown-content ${compactClass}`}>{elements}</div>;
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

export default PlanViewer;
