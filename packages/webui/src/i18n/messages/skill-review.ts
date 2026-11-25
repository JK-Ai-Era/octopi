/**
 * SkillReviewPanel 文案 — 技能审查队列/启用管理（skill-creator P3）。
 *
 * 键规约 `skillReview.<语义>`；zh/en 键全集一致。
 */

export const zh = {
  'skillReview.title': '技能审查',
  'skillReview.hint': 'agent 自创建技能经审查后生效（skill-creator）；放盘技能自动登记为 dropped-in',
  'skillReview.agentLabel': 'Agent',
  'skillReview.queueTitle': '审查队列',
  'skillReview.registryTitle': '已登记技能',
  'skillReview.emptyQueue': '无待审提交',
  'skillReview.emptyRegistry': '暂无登记',
  'skillReview.previewTitle': '提交预览',
  'skillReview.filesLabel': '文件清单',
  'skillReview.issuesLabel': '静态检查',
  'skillReview.findingsLabel': '审查意见',
  'skillReview.findingsPlaceholder': '审查意见（驳回时建议填写）',
  'skillReview.approve': '批准',
  'skillReview.reject': '驳回',
  'skillReview.enable': '启用',
  'skillReview.disable': '停用',
  'skillReview.reload': '刷新',
  'skillReview.reviewedBy': '审查者',
  'skillReview.unreviewed': '未经审查',
  'skillReview.opFailed': '操作失败：{error}',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'skillReview.title': 'Skill Review',
  'skillReview.hint': 'Agent-created skills activate after review (skill-creator); dropped-in skills are auto-enrolled as dropped-in',
  'skillReview.agentLabel': 'Agent',
  'skillReview.queueTitle': 'Review Queue',
  'skillReview.registryTitle': 'Registered Skills',
  'skillReview.emptyQueue': 'No pending submissions',
  'skillReview.emptyRegistry': 'Nothing registered yet',
  'skillReview.previewTitle': 'Submission Preview',
  'skillReview.filesLabel': 'Files',
  'skillReview.issuesLabel': 'Static checks',
  'skillReview.findingsLabel': 'Findings',
  'skillReview.findingsPlaceholder': 'Review findings (recommended when rejecting)',
  'skillReview.approve': 'Approve',
  'skillReview.reject': 'Reject',
  'skillReview.enable': 'Enable',
  'skillReview.disable': 'Disable',
  'skillReview.reload': 'Reload',
  'skillReview.reviewedBy': 'Reviewed by',
  'skillReview.unreviewed': 'unreviewed',
  'skillReview.opFailed': 'Operation failed: {error}',
};
