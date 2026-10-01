/**
 * Document 公用能力门面
 *
 * 读路径：二进制/文档 → Markdown；写路径不在此层。
 *
 * @module harness/context/capabilities/document
 */

export * from './types.js';
export { DocumentExtractError, isDocumentExtractError } from './errors.js';
export {
  DOCUMENT_EXTENSIONS,
  LEGACY_FORMATS,
  formatFromMagic,
  formatFromName,
  isDocumentPath,
  resolveFormat,
} from './format.js';
export { htmlFragmentToMarkdown } from './html-to-md.js';
export { createDefaultBackends, createDefaultDocumentPort } from './port.js';
export { plainTextBackend } from './backends/plain.js';
export { pdfUnpdfBackend } from './backends/pdf.js';
export { docxMammothBackend } from './backends/docx.js';
export { sheetXlsxBackend } from './backends/sheet.js';
export { officeParserBackend } from './backends/office-parser.js';
export { xmindBackend, xmindJsonToMarkdown, xmindXmlToMarkdown } from './backends/xmind.js';
export {
  createSofficeLegacyConverter,
  probeSoffice,
} from './legacy/soffice.js';
export { createLegacyConverterFromConfig } from './legacy/factory.js';
export type { SofficeLegacyOptions } from './legacy/soffice.js';
