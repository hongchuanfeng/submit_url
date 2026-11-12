const BAIDU_ENDPOINT = 'http://data.zz.baidu.com/urls';

/** 百度单次推送的条数上限 */
export const BAIDU_BATCH_SIZE = 2000;

/** 用于探测剩余额度的最小请求条数 */
const PROBE_SIZE = 1;

/** 单条链接的推送结果 */
export type PushItemStatus =
  | 'success' // 推送成功
  | 'not_same_site' // 失败：不是本站链接
  | 'not_valid' // 失败：不合法的链接
  | 'rejected' // 失败：百度未计入成功条数
  | 'quota'; // 未提交：当日配额已用尽

export interface PushItem {
  url: string;
  status: PushItemStatus;
  /** 中文说明 */
  message: string;
}

export interface BaiduPushResult {
  success: number;
  remain: number;
  notSameSite: string[];
  notValid: string[];
  /** 实际提交给百度的条数 */
  sent: number;
  /** 因当日配额不足而未提交的条数 */
  unsent: number;
  /** 是否因为当日配额耗尽而提前结束 */
  quotaExhausted: boolean;
  /** 实际发出的请求次数 */
  requests: number;
  /** 逐条链接的推送结果 */
  items: PushItem[];
  status: number;
}

export const PUSH_STATUS_TEXT: Record<PushItemStatus, string> = {
  success: '成功',
  not_same_site: '失败：非本站链接',
  not_valid: '失败：链接不合法',
  rejected: '失败：百度未确认接收',
  quota: '未提交：当日配额已用尽',
};

export class BaiduError extends Error {
  status: number;
  result?: BaiduPushResult;

  constructor(message: string, status: number, result?: BaiduPushResult) {
    super(message);
    this.name = 'BaiduError';
    this.status = status;
    this.result = result;
  }
}

/**
 * 规范化 site 参数。
 * 百度只接受裸域名（www.zorezoro.com），传 https://www.zorezoro.com 会返回 "site init fail"。
 */
export function normalizeSite(site: string): string {
  const value = site.trim();
  if (!value) return value;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.host.toLowerCase();
  } catch {
    return value.toLowerCase().replace(/^\/+|\/+$/g, '');
  }
}

/** 把百度返回的英文错误码翻译成可读的中文提示 */
export function explainBaiduError(message: string): string {
  const text = message.toLowerCase();

  if (text.includes('over quota')) {
    return '当日推送配额已用尽（剩余额度为 0），百度已整批拒绝本次提交；配额按天重置，请次日再试。';
  }
  if (text.includes('site init fail')) {
    return '站点（site）未被百度识别：请填写裸域名（例如 www.example.com，不要带 http:// 前缀），并确认该站点已在当前 token 对应的账号下完成验证。';
  }
  if (text.includes('site error')) {
    return '站点（site）与 token 不匹配：当前密钥没有该站点的推送权限，请在搜索资源平台确认站点与密钥的归属关系。';
  }
  if (text.includes('token')) {
    return '推送密钥（token）无效：请核对搜索资源平台申请到的准入密钥。';
  }
  if (text.includes('not same site')) {
    return '链接不属于指定的站点，请检查 site 与 sitemap 中的链接域名是否一致。';
  }
  if (text.includes('empty content')) {
    return '提交内容为空，没有可推送的链接。';
  }
  return message;
}

function isQuotaError(message: string): boolean {
  return message.toLowerCase().includes('over quota');
}

interface RawResponse {
  status: number;
  payload: Record<string, unknown>;
}

async function postBatch(site: string, token: string, urls: string[]): Promise<RawResponse> {
  const endpoint = `${BAIDU_ENDPOINT}?site=${encodeURIComponent(site)}&token=${encodeURIComponent(token)}`;
  const body = urls.join('\n');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new BaiduError('推送超时（30 秒），请稍后重试', 504);
    }
    throw new BaiduError(`推送失败：${(error as Error).message ?? '网络错误'}`, 502);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const message =
      (typeof payload.message === 'string' && payload.message) ||
      `HTTP ${response.status} ${response.statusText}`;
    throw new BaiduError(explainBaiduError(message), response.status, {
      success: 0,
      remain: 0,
      notSameSite: [],
      notValid: [],
      sent: 0,
      unsent: urls.length,
      quotaExhausted: isQuotaError(message),
      requests: 1,
      items: [],
      status: response.status,
    });
  }

  return { status: response.status, payload };
}

/**
 * 按百度接口要求推送链接集合：每行一条，纯文本 body。
 *
 * 关键点：百度会整批校验剩余额度——只要本次提交的条数超过当天剩余额度（remain），
 * 整批都会被拒绝并返回 "over quota"，而不是部分接收。因此这里先用 1 条做探测，
 * 拿到真实 remain 后，再按 min(2000, remain) 分批提交。
 */
export async function pushUrls(site: string, token: string, urls: string[]): Promise<BaiduPushResult> {
  if (urls.length === 0) {
    throw new BaiduError('没有可推送的链接（解析结果为空，或全部被站点过滤规则过滤掉了）', 400);
  }

  const normalizedSite = normalizeSite(site);
  const totals = {
    success: 0,
    remain: 0,
    notSameSite: [] as string[],
    notValid: [] as string[],
    sent: 0,
    requests: 0,
  };
  const items: PushItem[] = [];
  let quotaExhausted = false;
  let cursor = 0;

  while (cursor < urls.length) {
    // 探测阶段只发 1 条，用于拿到当天剩余额度；之后按剩余额度分批。
    const size = totals.requests === 0 ? PROBE_SIZE : Math.min(BAIDU_BATCH_SIZE, totals.remain);
    const batchSize = Math.max(1, Math.min(size, urls.length - cursor));
    const batch = urls.slice(cursor, cursor + batchSize);

    let raw: RawResponse;
    try {
      raw = await postBatch(normalizedSite, token, batch);
    } catch (error) {
      if (error instanceof BaiduError && error.result?.quotaExhausted) {
        // 额度不足：这一批及其之后的链接都没有被百度接收
        quotaExhausted = true;
        totals.sent = cursor;
        for (const url of urls.slice(cursor)) {
          items.push({
            url,
            status: 'quota',
            message: PUSH_STATUS_TEXT.quota,
          });
        }
        break;
      }
      throw error;
    }

    totals.requests += 1;
    totals.sent += batch.length;
    cursor += batch.length;

    const { payload } = raw;
    const batchSuccess = typeof payload.success === 'number' ? payload.success : 0;
    totals.success += batchSuccess;
    totals.remain = typeof payload.remain === 'number' ? payload.remain : totals.remain;
    if (Array.isArray(payload.not_same_site)) {
      totals.notSameSite.push(...(payload.not_same_site as string[]));
    }
    if (Array.isArray(payload.not_valid)) {
      totals.notValid.push(...(payload.not_valid as string[]));
    }

    const batchNotSame = Array.isArray(payload.not_same_site) ? (payload.not_same_site as string[]) : [];
    const batchNotValid = Array.isArray(payload.not_valid) ? (payload.not_valid as string[]) : [];

    // 逐条归因：百度只回传失败明细，成功的是「总数」，
    // 因此用失败清单做差集，剩下的链接按 success 条数依次标记为成功。
    const notSameSet = new Set(batchNotSame);
    const notValidSet = new Set(batchNotValid);
    const pending: string[] = [];

    for (const url of batch) {
      if (notValidSet.has(url)) {
        items.push({ url, status: 'not_valid', message: PUSH_STATUS_TEXT.not_valid });
      } else if (notSameSet.has(url)) {
        items.push({ url, status: 'not_same_site', message: PUSH_STATUS_TEXT.not_same_site });
      } else {
        pending.push(url);
      }
    }

    pending.forEach((url, index) => {
      if (index < batchSuccess) {
        items.push({ url, status: 'success', message: PUSH_STATUS_TEXT.success });
      } else {
        items.push({ url, status: 'rejected', message: PUSH_STATUS_TEXT.rejected });
      }
    });

    if (totals.remain <= 0) {
      quotaExhausted = true;
      for (const url of urls.slice(cursor)) {
        items.push({ url, status: 'quota', message: PUSH_STATUS_TEXT.quota });
      }
      break;
    }
  }

  return {
    success: totals.success,
    remain: totals.remain,
    notSameSite: totals.notSameSite,
    notValid: totals.notValid,
    sent: totals.sent,
    unsent: urls.length - totals.sent,
    quotaExhausted,
    requests: totals.requests,
    items,
    status: 200,
  };
}
