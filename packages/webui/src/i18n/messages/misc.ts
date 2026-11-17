/**
 * i18n 分片：misc — FileDelivery / ClientToolCallCard / ErrorCard /
 * error-classify / MarkdownMessage / OpFeedback / DescriptionSourceBadge。
 * 契约见 arch/i18n-extraction-spec.md。
 *
 * @module
 */

export const zh = {
  'fileDelivery.title': '文件',
  'fileDelivery.emptyHint': 'Agent 发送的文件会显示在这里。点击对话中的文件名可打开。',
  'fileDelivery.count': '{count} 个',
  'fileDelivery.save': '转存',
  'fileDelivery.saveToLocal': '转存到本地',
  'fileDelivery.preview': '预览',
  'fileDelivery.openPreview': '打开预览',
  'fileDelivery.sizeCount': '{size} 字节',
  'fileDelivery.loading': '加载中…',
  'fileDelivery.reading': '读取中…',
  'fileDelivery.binaryNoPreview': '二进制 / 文档文件，不支持在线预览',
  'fileDelivery.notConnected': '未连接，无法转存',
  'fileDelivery.processing': '处理中…',

  'clientToolCallCard.capability': '客户端能力',
  'clientToolCallCard.webPage': '网页',
  'clientToolCallCard.webForm': '网页表单',
  'clientToolCallCard.modeForm': '交互表单',
  'clientToolCallCard.modeDisplay': '纯展示',
  'clientToolCallCard.modeFile': '文件',
  'clientToolCallCard.purpose': '用途：{purpose}',
  'clientToolCallCard.unsupported': '该端未实现专属 UI，可取消本次调用。',
  'clientToolCallCard.cancel': '取消',
  'clientToolCallCard.maximize': '最大化',
  'clientToolCallCard.restore': '还原',
  'clientToolCallCard.sizeSent': '{size} 字节 · 已发送',
  'clientToolCallCard.missingHtml': '缺少 html 参数，无法渲染。',
  'clientToolCallCard.submitting': '提交中…',
  'clientToolCallCard.done': '完成',
  'clientToolCallCard.skip': '跳过',
  'clientToolCallCard.shown': '已展示，agent 可继续。',
  'clientToolCallCard.photoConsent': '需要使用摄像头/相册采集图片。',
  'clientToolCallCard.allow': '允许',
  'clientToolCallCard.deny': '拒绝',
  'clientToolCallCard.uploading': '上传中…',
  'clientToolCallCard.chooseImage': '选择图片',

  'errorCard.copyDiagnosticId': '复制诊断 ID',
  'errorCard.copied': '已复制',
  'errorCard.diagnosticId': '诊断 ID：{id}',
  'errorCard.hideRaw': '收起技术细节',
  'errorCard.showRaw': '技术细节',

  'errorClassify.openSettings': '去设置',

  'markdownMessage.copyCode': '复制代码',
  'markdownMessage.copy': '复制',

  'opFeedback.processing': '处理中…',
  'opFeedback.timeoutWithSeconds':
    '请求超时（{seconds}s）：服务可能正忙于解析/向量回填，请稍后看统计条是否变化',
  'opFeedback.timeout': '请求超时',

  'descriptionSourceBadge.llmLabel': 'LLM 生成',
  'descriptionSourceBadge.llmTitle': '此描述由 LLM 生成（gateway 代生成，素材经密钥扫描）；人工描述优先于它',
  'descriptionSourceBadge.heuristicLabel': '启发式',
  'descriptionSourceBadge.heuristicTitle': '此描述由启发式规则（名称/路径推断）生成；人工描述优先于它',
  'descriptionSourceBadge.blockedSecretLabel': '启发式 · 密钥封锁',
  'descriptionSourceBadge.blockedSecretTitle': '抽样含密钥形态，素材未外发（fail-safe）；描述为启发式兜底',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'fileDelivery.title': 'Files',
  'fileDelivery.emptyHint':
    'Files sent by the agent appear here. Click a file name in the conversation to open it.',
  'fileDelivery.count': '{count} file(s)',
  'fileDelivery.save': 'Save',
  'fileDelivery.saveToLocal': 'Save to local',
  'fileDelivery.preview': 'Preview',
  'fileDelivery.openPreview': 'Open preview',
  'fileDelivery.sizeCount': '{size} bytes',
  'fileDelivery.loading': 'Loading…',
  'fileDelivery.reading': 'Reading…',
  'fileDelivery.binaryNoPreview': 'Binary / document file — inline preview not supported',
  'fileDelivery.notConnected': 'Not connected — cannot save',
  'fileDelivery.processing': 'Processing…',

  'clientToolCallCard.capability': 'Client capability',
  'clientToolCallCard.webPage': 'Web page',
  'clientToolCallCard.webForm': 'Web form',
  'clientToolCallCard.modeForm': 'interactive form',
  'clientToolCallCard.modeDisplay': 'display only',
  'clientToolCallCard.modeFile': 'file',
  'clientToolCallCard.purpose': 'Purpose: {purpose}',
  'clientToolCallCard.unsupported': 'This client has no dedicated UI for this call; you can cancel it.',
  'clientToolCallCard.cancel': 'Cancel',
  'clientToolCallCard.maximize': 'Maximize',
  'clientToolCallCard.restore': 'Restore',
  'clientToolCallCard.sizeSent': '{size} bytes · sent',
  'clientToolCallCard.missingHtml': 'Missing html argument — cannot render.',
  'clientToolCallCard.submitting': 'Submitting…',
  'clientToolCallCard.done': 'Done',
  'clientToolCallCard.skip': 'Skip',
  'clientToolCallCard.shown': 'Shown; the agent can continue.',
  'clientToolCallCard.photoConsent': 'Camera/gallery access is required to capture an image.',
  'clientToolCallCard.allow': 'Allow',
  'clientToolCallCard.deny': 'Deny',
  'clientToolCallCard.uploading': 'Uploading…',
  'clientToolCallCard.chooseImage': 'Choose image',

  'errorCard.copyDiagnosticId': 'Copy diagnostic ID',
  'errorCard.copied': 'Copied',
  'errorCard.diagnosticId': 'Diagnostic ID: {id}',
  'errorCard.hideRaw': 'Hide technical details',
  'errorCard.showRaw': 'Technical details',

  'errorClassify.openSettings': 'Open settings',

  'markdownMessage.copyCode': 'Copy code',
  'markdownMessage.copy': 'Copy',

  'opFeedback.processing': 'Processing…',
  'opFeedback.timeoutWithSeconds':
    'Request timed out ({seconds}s): the service may be busy parsing or backfilling vectors; check the stats bar again shortly',
  'opFeedback.timeout': 'Request timed out',

  'descriptionSourceBadge.llmLabel': 'LLM generated',
  'descriptionSourceBadge.llmTitle':
    'This description was generated by an LLM (generated via gateway, material scanned for secrets); a manual description takes precedence',
  'descriptionSourceBadge.heuristicLabel': 'Heuristic',
  'descriptionSourceBadge.heuristicTitle':
    'This description was generated by heuristic rules (inferred from name/path); a manual description takes precedence',
  'descriptionSourceBadge.blockedSecretLabel': 'Heuristic · secret blocked',
  'descriptionSourceBadge.blockedSecretTitle':
    'Sample contained secret-like material, so nothing was sent out (fail-safe); the description falls back to heuristics',
};
