/**
 * ClientToolCallCard — Client Tool pending 卡片
 *
 * 支持：
 * - html_ui（interaction=ui）
 *   - mode=display：纯展示，挂载即 resolve，预览保留
 *   - mode=form：内嵌表单；提交/「完成」回传 values
 * - send_file（interaction=ui）：签发 fileId，挂载即 resolve，正文走内容 API
 * - photo_capture（interaction=device）：purpose + 同意 + 拍照/选图 → upload attachment → kind:asset
 */

import { useEffect, useRef, useState, type Ref } from 'react';
import type {
  ClientToolCallDto,
  ClientToolCallOutcomeDto,
  OctopiClient,
} from '@octopi-agent/gateway/web/sdk/client';
import type { FileRef } from './FileDelivery';
import { useT } from '../i18n/react';

export interface RenderedWebView {
  id: string;
  title: string;
  html: string;
  height: number;
  mode: 'display' | 'form';
  createdAt: number;
}

export interface ClientToolCallCardProps {
  call: ClientToolCallDto;
  client: OctopiClient;
  sessionId: string;
  busy: boolean;
  onResolved: () => void;
  onWebView?: (view: RenderedWebView) => void;
  /** send_file：登记文件引用（时间线卡片 + 右栏） */
  onFileRef?: (ref: FileRef, createdAt: number) => void;
}

/** 注入：表单提交 / 收集 values → postMessage 给父页（iframe 非 same-origin） */
const OCTOPI_FORM_HELPER = `
<script>
(function () {
  function collect() {
    var values = {};
    var forms = document.forms;
    for (var i = 0; i < forms.length; i++) {
      var fd = new FormData(forms[i]);
      fd.forEach(function (v, k) { values[k] = v; });
    }
    document.querySelectorAll('input[name],select[name],textarea[name]').forEach(function (el) {
      if (el.type === 'checkbox') {
        values[el.name] = !!el.checked;
      } else if (el.type === 'radio') {
        if (el.checked) values[el.name] = el.value;
      } else if (!(el.name in values) && el.value != null && el.value !== '') {
        values[el.name] = el.value;
      }
    });
    return values;
  }
  document.addEventListener('submit', function (e) {
    e.preventDefault();
    parent.postMessage({ type: 'octopi.form.submit', values: collect() }, '*');
  });
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'octopi.form.collect') {
      parent.postMessage({ type: 'octopi.form.values', values: collect(), token: e.data.token }, '*');
    }
  });
})();
<\/script>
`;

function injectFormHelper(html: string): string {
  if (html.includes('octopi.form.submit')) return html;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${OCTOPI_FORM_HELPER}</head>`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/(<body[^>]*>)/i, `$1${OCTOPI_FORM_HELPER}`);
  return `<!doctype html><html><head><meta charset="utf-8"/>${OCTOPI_FORM_HELPER}</head><body>${html}</body></html>`;
}

function HtmlFrame({
  title,
  html,
  mode,
  height,
  frameRef,
}: {
  title: string;
  html: string;
  mode: 'display' | 'form';
  height: number;
  frameRef?: Ref<HTMLIFrameElement>;
}) {
  const [maximized, setMaximized] = useState(false);
  const t = useT();
  const srcDoc = mode === 'form' ? injectFormHelper(html) : html;
  const toggleLabel = maximized ? t('clientToolCallCard.restore') : t('clientToolCallCard.maximize');

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div className="small muted" style={{ flex: 1 }}>
          {title}
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setMaximized((v) => !v)}
          title={toggleLabel}
        >
          {toggleLabel}
        </button>
      </div>
      <iframe
        ref={frameRef}
        title={title}
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
        srcDoc={srcDoc}
        style={
          maximized
            ? {
                position: 'fixed',
                inset: 0,
                zIndex: 1000,
                width: '100vw',
                height: '100vh',
                border: 'none',
                background: '#fff',
              }
            : {
                width: '100%',
                height,
                border: '1px solid var(--border-color, #e5e7eb)',
                borderRadius: 8,
                background: '#fff',
              }
        }
      />
      {maximized ? (
        <button
          type="button"
          className="btn-primary"
          onClick={() => setMaximized(false)}
          style={{
            position: 'fixed',
            top: 12,
            right: 12,
            zIndex: 1001,
          }}
        >
          {t('clientToolCallCard.restore')}
        </button>
      ) : null}
    </>
  );
}

/** 持久化 HTML 预览（关闭后仍可见） */
export function WebViewPreview({ view }: { view: RenderedWebView }) {
  const t = useT();
  return (
    <div className="panel" style={{ borderColor: 'var(--color-accent, #2563eb)', marginBottom: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>
        <span style={{ color: 'var(--color-accent, #2563eb)' }}>
          {view.mode === 'form' ? t('clientToolCallCard.webForm') : t('clientToolCallCard.webPage')}
        </span>
      </div>
      <HtmlFrame title={view.title} html={view.html} mode={view.mode} height={view.height} />
    </div>
  );
}

function parseHtmlUiArgs(args: Record<string, unknown> | undefined, fallbackTitle: string) {
  const a = args ?? {};
  const title = typeof a.title === 'string' && a.title.trim() ? a.title.trim() : fallbackTitle;
  const html = typeof a.html === 'string' ? a.html : '';
  const height = normalizeHeight(a.height);
  const mode: 'display' | 'form' = a.mode === 'form' ? 'form' : 'display';
  return { title, html, height, mode };
}

export function ClientToolCallCard({
  call,
  client,
  sessionId,
  busy,
  onResolved,
  onWebView,
  onFileRef,
}: ClientToolCallCardProps) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const t = useT();
  const locked = busy || submitting;

  const finish = async (outcome: ClientToolCallOutcomeDto, keepPreview?: RenderedWebView) => {
    if (locked) return;
    setError(null);
    setSubmitting(true);
    try {
      await client.resolveClientToolCall(call.id, outcome);
      if (keepPreview && onWebView) onWebView(keepPreview);
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const htmlUi =
    call.name === 'html_ui'
      ? parseHtmlUiArgs(call.args as Record<string, unknown>, t('clientToolCallCard.webPage'))
      : null;
  const fileRef: FileRef | null =
    call.name === 'send_file' && call.fileRef?.fileId ? call.fileRef : null;
  const preview: RenderedWebView | null = htmlUi?.html
    ? {
        id: call.id,
        title: htmlUi.title,
        html: htmlUi.html,
        height: htmlUi.height,
        mode: htmlUi.mode,
        createdAt: call.createdAt || Date.now(),
      }
    : null;

  return (
    <div className="panel question-card" style={{ borderColor: 'var(--color-accent, #2563eb)', marginBottom: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        <span style={{ color: 'var(--color-accent, #2563eb)' }}>{t('clientToolCallCard.capability')}</span>
        <span style={{ marginLeft: 8, fontWeight: 400 }} className="small muted">
          {call.name}
          {htmlUi
            ? ` · ${t(htmlUi.mode === 'form' ? 'clientToolCallCard.modeForm' : 'clientToolCallCard.modeDisplay')}`
            : ''}
          {fileRef ? ` · ${t('clientToolCallCard.modeFile')}` : ''}
        </span>
      </div>
      {call.args && typeof call.args === 'object' && 'purpose' in call.args ? (
        <div className="small muted" style={{ marginBottom: 8 }}>
          {t('clientToolCallCard.purpose', {
            purpose: String((call.args as { purpose?: unknown }).purpose ?? ''),
          })}
        </div>
      ) : null}

      {htmlUi ? (
        <HtmlUiBody
          mode={htmlUi.mode}
          title={htmlUi.title}
          html={htmlUi.html}
          height={htmlUi.height}
          locked={locked}
          onDisplayReady={() => {
            if (htmlUi.mode !== 'display' || locked) return;
            void finish(
              { status: 'ok', result: { kind: 'value', data: { shown: true } } },
              preview ?? undefined,
            );
          }}
          onFormValues={(values) => {
            void finish(
              { status: 'ok', result: { kind: 'value', data: { submitted: true, values } } },
              preview ?? undefined,
            );
          }}
          onDismissForm={() => {
            void finish(
              { status: 'ok', result: { kind: 'value', data: { submitted: false, values: {} } } },
              preview ?? undefined,
            );
          }}
        />
      ) : fileRef ? (
        <SendFileBody
          locked={locked}
          fileRef={fileRef}
          onReady={() => {
            if (locked) return;
            if (onFileRef) onFileRef(fileRef, call.createdAt || Date.now());
            void finish({
              status: 'ok',
              result: {
                kind: 'value',
                data: {
                  shown: true,
                  fileId: fileRef.fileId,
                  name: fileRef.name,
                  mime: fileRef.mime,
                  sizeBytes: fileRef.sizeBytes,
                },
              },
            });
          }}
        />
      ) : call.name === 'photo_capture' ? (
        <PhotoCaptureBody
          disabled={locked}
          client={client}
          sessionId={sessionId}
          onAsset={(result) => void finish({ status: 'ok', result })}
          onDeny={() => void finish({ status: 'error', reason: 'consent_denied', hint: 'user denied camera' })}
          onError={(msg) => setError(msg)}
        />
      ) : (
        <div className="small" style={{ marginBottom: 8 }}>
          {t('clientToolCallCard.unsupported')}
        </div>
      )}

      {!htmlUi && !fileRef ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            className="btn-secondary"
            disabled={locked}
            onClick={() => void finish({ status: 'error', reason: 'cancelled', hint: 'user cancelled' })}
          >
            {t('clientToolCallCard.cancel')}
          </button>
        </div>
      ) : null}
      {error ? <div className="small" style={{ color: 'var(--color-danger, #dc2626)', marginTop: 6 }}>{error}</div> : null}
    </div>
  );
}

function SendFileBody({
  locked,
  fileRef,
  onReady,
}: {
  locked: boolean;
  fileRef: FileRef;
  onReady: () => void;
}) {
  const firedRef = useRef(false);
  const t = useT();
  useEffect(() => {
    if (firedRef.current || locked) return;
    firedRef.current = true;
    const timer = setTimeout(onReady, 0);
    return () => clearTimeout(timer);
  }, [locked, onReady]);

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div className="small" style={{ wordBreak: 'break-all' }}>
        {fileRef.name}
      </div>
      <div className="small muted">
        {fileRef.mime || 'application/octet-stream'} ·{' '}
        {t('clientToolCallCard.sizeSent', { size: fileRef.sizeBytes.toLocaleString() })}
      </div>
    </div>
  );
}

function HtmlUiBody({
  mode,
  title,
  html,
  height,
  locked,
  onDisplayReady,
  onFormValues,
  onDismissForm,
}: {
  mode: 'display' | 'form';
  title: string;
  html: string;
  height: number;
  locked: boolean;
  onDisplayReady: () => void;
  onFormValues: (values: Record<string, unknown>) => void;
  onDismissForm: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [collecting, setCollecting] = useState(false);
  const displayFiredRef = useRef(false);
  const t = useT();

  useEffect(() => {
    if (mode !== 'form') return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; values?: Record<string, unknown> } | null;
      if (data?.type === 'octopi.form.submit' && data.values) {
        onFormValues(data.values);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [mode, onFormValues]);

  useEffect(() => {
    if (mode !== 'display' || displayFiredRef.current) return;
    displayFiredRef.current = true;
    const timer = setTimeout(onDisplayReady, 0);
    return () => clearTimeout(timer);
  }, [mode, onDisplayReady]);

  const collectAndSubmit = () => {
    if (locked || collecting) return;
    setCollecting(true);
    const token = Math.random().toString(36).slice(2);
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; values?: Record<string, unknown>; token?: string } | null;
      if (data?.type === 'octopi.form.values' && data.token === token) {
        window.removeEventListener('message', onMessage);
        setCollecting(false);
        onFormValues(data.values ?? {});
      }
    };
    window.addEventListener('message', onMessage);
    frameRef.current?.contentWindow?.postMessage({ type: 'octopi.form.collect', token }, '*');
    setTimeout(() => {
      window.removeEventListener('message', onMessage);
      setCollecting(false);
    }, 1000);
  };

  if (!html) {
    return <div className="small">{t('clientToolCallCard.missingHtml')}</div>;
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <HtmlFrame
        title={title}
        html={html}
        mode={mode}
        height={height}
        frameRef={frameRef}
      />
      {mode === 'form' ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-primary" disabled={locked || collecting} onClick={collectAndSubmit}>
            {collecting ? t('clientToolCallCard.submitting') : t('clientToolCallCard.done')}
          </button>
          <button className="btn-secondary" disabled={locked || collecting} onClick={onDismissForm}>
            {t('clientToolCallCard.skip')}
          </button>
        </div>
      ) : (
        <div className="small muted">{t('clientToolCallCard.shown')}</div>
      )}
    </div>
  );
}

function normalizeHeight(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : Number(raw);
  if (!Number.isFinite(n)) return 420;
  return Math.min(Math.max(160, Math.trunc(n)), 1200);
}

function PhotoCaptureBody({
  disabled,
  client,
  sessionId,
  onAsset,
  onDeny,
  onError,
}: {
  disabled: boolean;
  client: OctopiClient;
  sessionId: string;
  onAsset: (result: {
    kind: 'asset';
    assetId: string;
    mime: string;
    sizeBytes: number;
    name?: string;
    preview?: string;
  }) => void;
  onDeny: () => void;
  onError: (msg: string) => void;
}) {
  const [consented, setConsented] = useState(false);
  const [uploading, setUploading] = useState(false);
  const t = useT();

  const onFile = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    try {
      const dataBase64 = await fileToBase64(file);
      const [att] = await client.uploadSessionAttachments(sessionId, [
        {
          name: file.name || 'photo.jpg',
          mime: file.type || 'image/jpeg',
          dataBase64,
        },
      ]);
      if (!att) throw new Error('upload returned no attachment');
      onAsset({
        kind: 'asset',
        assetId: att.id,
        mime: att.mime || file.type || 'image/jpeg',
        sizeBytes: att.sizeBytes ?? file.size,
        name: att.name || file.name,
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  if (!consented) {
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        <div className="small">{t('clientToolCallCard.photoConsent')}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-primary" disabled={disabled} onClick={() => setConsented(true)}>
            {t('clientToolCallCard.allow')}
          </button>
          <button className="btn-secondary" disabled={disabled} onClick={onDeny}>
            {t('clientToolCallCard.deny')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <label className="btn-secondary" style={{ display: 'inline-block', cursor: 'pointer' }}>
        {uploading ? t('clientToolCallCard.uploading') : t('clientToolCallCard.chooseImage')}
        <input
          type="file"
          accept="image/*"
          disabled={disabled || uploading}
          style={{ display: 'none' }}
          onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
        />
      </label>
      <button className="btn-secondary" disabled={disabled} onClick={onDeny}>
        {t('clientToolCallCard.cancel')}
      </button>
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}
