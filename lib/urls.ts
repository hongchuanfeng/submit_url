/**
 * 批量提交 URL 的输入解析：拆分、校验、去重。
 *
 * 与 sitemap 模式不同，这里没有「一个 sitemap 一组」的天然分组，
 * 所有 URL 属于同一批，按单站点推送。
 */

/** 单条输入的处理结果 */
export type UrlEntryKind = 'valid' | 'duplicate' | 'invalid';

export interface UrlEntry {
  /** 原始输入（已去除首尾空白） */
  url: string;
  /** 在输入中的序号（从 0 开始） */
  index: number;
  /** 校验与去重结果 */
  kind: UrlEntryKind;
  /** kind 为 invalid 时的原因说明 */
  reason?: string;
  /** kind 为 duplicate 时，指向首次出现的那一条的序号 */
  firstIndex?: number;
}

export interface ParsedUrlList {
  /** 按输入顺序排列的全部条目（含重复与非法项） */
  entries: UrlEntry[];
  /** 去重后的有效 URL（保持首次出现顺序） */
  urls: string[];
  /** 输入中非空行的总数 */
  inputCount: number;
}

/** 校验单个 URL：必须是带 http/https 协议的完整地址 */
export function validateUrl(url: string): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      reason: '不是合法的 URL，请填写完整地址（含 http:// 或 https:// 协议头）',
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: `不支持的协议「${parsed.protocol}」，请使用 http:// 或 https://`,
    };
  }

  if (!parsed.hostname) {
    return { ok: false, reason: 'URL 缺少域名' };
  }

  return { ok: true };
}

/**
 * 解析批量提交的 URL 输入。
 * 支持数组或换行分隔的多行字符串；逐行校验并去重。
 */
export function parseUrlList(input: string[] | string | undefined): ParsedUrlList {
  const raw: string[] = [];

  if (Array.isArray(input)) {
    raw.push(...input);
  } else if (typeof input === 'string') {
    raw.push(...input.split(/\r?\n/));
  }

  const entries: UrlEntry[] = [];
  const urls: string[] = [];
  const seen = new Map<string, number>();
  let inputCount = 0;

  raw.forEach((item) => {
    const value = (item ?? '').trim();
    if (!value) return;

    const index = inputCount;
    inputCount += 1;

    const check = validateUrl(value);
    if (!check.ok) {
      entries.push({ url: value, index, kind: 'invalid', reason: check.reason });
      return;
    }

    const firstIndex = seen.get(value);
    if (firstIndex !== undefined) {
      entries.push({ url: value, index, kind: 'duplicate', firstIndex });
      return;
    }

    seen.set(value, index);
    urls.push(value);
    entries.push({ url: value, index, kind: 'valid' });
  });

  return { entries, urls, inputCount };
}
