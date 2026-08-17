import { XMLValidator } from 'fast-xml-parser';

export const DRAWIO_MAX_XML_BYTES = 80 * 1_024;

export type DrawioValidationResult =
  | Readonly<{
      ok: true;
      xml: string;
      cells: number;
      edges: number;
    }>
  | Readonly<{
      ok: false;
      error: 'invalidPath' | 'invalidXml';
      message: string;
    }>;

const markdownFence = /^```(?:xml|drawio)?\s*\n([\s\S]*?)\n```$/iu;

export const normalizeDrawioXml = (value: string): string => {
  const trimmed = value.trim().replace(/^\uFEFF/u, '');
  const fenced = markdownFence.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
};

export const isDrawioPath = (value: string): boolean => {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > 1_024 ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[a-z]:[\\/]/iu.test(value) ||
    [...value].some((character) => /\p{Cc}/u.test(character))
  ) {
    return false;
  }
  const parts = value.split(/[\\/]/u);
  return (
    parts.length <= 64 &&
    parts.every((part) => part.length > 0 && part !== '.' && part !== '..') &&
    /\.drawio$/iu.test(parts.at(-1) ?? '')
  );
};

export const validateDrawioXml = (value: string): DrawioValidationResult => {
  const xml = normalizeDrawioXml(value);
  if (xml.length === 0) {
    return { ok: false, error: 'invalidXml', message: 'Draw.io XML is empty.' };
  }
  if (Buffer.byteLength(xml, 'utf8') > DRAWIO_MAX_XML_BYTES) {
    return {
      ok: false,
      error: 'invalidXml',
      message: `Draw.io XML exceeds the ${DRAWIO_MAX_XML_BYTES}-byte generation limit. Simplify the diagram and try again.`,
    };
  }
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    return {
      ok: false,
      error: 'invalidXml',
      message: 'Draw.io XML must not contain DOCTYPE or ENTITY declarations.',
    };
  }
  if (!/^<\?xml\b[^>]*>\s*<(?:mxGraphModel|mxfile)\b|^<(?:mxGraphModel|mxfile)\b/iu.test(xml)) {
    return {
      ok: false,
      error: 'invalidXml',
      message: 'Draw.io XML must use an mxGraphModel or mxfile root element.',
    };
  }
  if (!/<mxGraphModel\b/iu.test(xml) || !/<root\b/iu.test(xml)) {
    return {
      ok: false,
      error: 'invalidXml',
      message: 'Draw.io XML must contain an uncompressed mxGraphModel with a root element.',
    };
  }
  const validation = XMLValidator.validate(xml, {
    allowBooleanAttributes: true,
  });
  if (validation !== true) {
    const detail =
      typeof validation === 'object' &&
      validation !== null &&
      'err' in validation &&
      typeof validation.err === 'object' &&
      validation.err !== null &&
      'msg' in validation.err &&
      typeof validation.err.msg === 'string'
        ? validation.err.msg
        : 'The XML is not well formed.';
    return { ok: false, error: 'invalidXml', message: detail };
  }
  const ids = [...xml.matchAll(/<mxCell\b[^>]*\bid=(['"])(.*?)\1/giu)].map(
    (match) => match[2] ?? '',
  );
  if (!ids.includes('0') || !ids.includes('1')) {
    return {
      ok: false,
      error: 'invalidXml',
      message: 'Draw.io XML must contain the standard mxCell roots with ids 0 and 1.',
    };
  }
  if (new Set(ids).size !== ids.length) {
    return {
      ok: false,
      error: 'invalidXml',
      message: 'Every mxCell must have a unique id.',
    };
  }
  const edges = [...xml.matchAll(/<mxCell\b[^>]*\bedge=(['"])1\1/giu)].length;
  return { ok: true, xml: `${xml}\n`, cells: ids.length, edges };
};

export const drawioAddPatch = (path: string, xml: string): string => [
  '*** Begin Patch',
  `*** Add File: ${path}`,
  ...xml.replace(/\n$/u, '').split('\n').map((line) => `+${line}`),
  '*** End Patch',
].join('\n');
