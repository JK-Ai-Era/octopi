import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Components } from 'react-markdown';
import { useT } from '../i18n/react';

/**
 * Copy text to the clipboard, tolerating non-secure contexts.
 * navigator.clipboard exists only in secure contexts (HTTPS / localhost); over
 * plain http on a LAN address it is undefined, so fall back to the legacy
 * textarea + execCommand('copy') path. Returns false only when both paths fail.
 */
function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => copyViaExecCommand(text),
    );
  }
  return Promise.resolve(copyViaExecCommand(text));
}

function copyViaExecCommand(text: string): boolean {
  // Swallow DOM/execCommand failures here only: the caller surfaces the boolean
  // as explicit UI feedback, so a swallowed error is never silent to the user.
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const handleCopy = () => {
    void copyText(text).then((ok) => {
      setState(ok ? 'copied' : 'failed');
      window.setTimeout(() => setState('idle'), 2000);
    });
  };

  return (
    <button
      type="button"
      className="md-copy-btn"
      onClick={handleCopy}
      aria-label={t('markdownMessage.copyCode')}
      title={t('markdownMessage.copyCode')}
    >
      {state === 'copied'
        ? t('markdownMessage.copied')
        : state === 'failed'
          ? t('markdownMessage.copyFailed')
          : t('markdownMessage.copy')}
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
    const language = className?.match(/language-(\S+)/)?.[1] ?? '';

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
