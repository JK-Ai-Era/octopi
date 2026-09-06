import { memo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Components } from 'react-markdown';

function CopyButton({ text }: { text: string }) {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Ignore clipboard failures in sandboxed environments.
    }
  };

  return (
    <button
      type="button"
      className="md-copy-btn"
      onClick={handleCopy}
      aria-label="复制代码"
      title="复制代码"
    >
      复制
    </button>
  );
}

const components: Components = {
  p({ children }) {
    return <div className="md-paragraph">{children}</div>;
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children;
    const isCodeBlock =
      child && typeof child === 'object' && 'props' in child && child.props?.className?.includes('language-');
    if (isCodeBlock) {
      return <div className="md-code-block">{children}</div>;
    }

    return <pre className="md-raw-pre">{children}</pre>;
  },
  code({ className, children }) {
    const text = extractText(children);
    const language = className?.replace('language-', '') ?? '';

    if (className) {
      return (
        <code className={`md-code ${className}`}>
          {language ? <span className="md-code-lang">{language}</span> : null}
          <CopyButton text={text} />
          {children}
        </code>
      );
    }

    return <code className="md-inline-code">{children}</code>;
  },
  table({ children }) {
    return (
      <div className="md-table-scroll">
        <table>{children}</table>
      </div>
    );
  },
  blockquote({ children }) {
    return <blockquote className="md-blockquote">{children}</blockquote>;
  },
  img({ alt, src, title }) {
    return (
      <span className="md-image-wrapper">
        <img alt={alt ?? ''} src={src ?? ''} title={title ?? undefined} loading="lazy" />
      </span>
    );
  },
};

function extractText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') {
    return '';
  }

  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(extractText).join('');
  }

  if (typeof node === 'object' && 'props' in node) {
    return extractText((node as { props?: { children?: ReactNode } }).props?.children);
  }

  return '';
}

function MarkdownMessageBase({ content }: { content: string }) {
  return (
    <div className="md-root">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownMessage = memo(MarkdownMessageBase);
