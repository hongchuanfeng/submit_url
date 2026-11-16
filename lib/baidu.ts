import { normalizeSite } from './site';

export { normalizeSite };

/**
 * 百度推送接口地址。
 * 默认指向百度官方接口；可通过环境变量覆盖（仅用于本地联调）。
 * 在请求时读取，方便测试用例临时切换到假服务器。
 */
function baiduEndpoint(): string {
  return process.env.BAIDU_ENDPOINT?.trim() || 'http://data.zz.baidu.com/urls';
}

/** 百度单次推送的条数上限 */
export const BAIDU_BATCH_SIZE = 2000;

/** 用于探测剩余额度的最小请求条数 */
const PROBE_SIZE = 1;

/** 单条链接的推送结果 */
export type PushItemStatus =
  | 'success' // 推送成功
  | 'not_same_site' // 失败：不是本站链接
  | 'not_valid' // 失败：不合法的 url
  | 'rejected' // 失败：百度未计入成功条数
  | 'quota' // 未提交：当日配额已用尽
  | 'duplicate' // 未重复提交：已在其它 sitemap 中提交过
  | 'error'; // 未提交：接口报错

export interface PushItem {
  url: string;
  status: PushItemStatus;
  /** 中文说明 */
  message: string;
  /** 该链接来自哪个 sitemap（分组提交时使用） */
  sitemap?: string;
}

/** 逐条推送结果的汇总 */
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

/** 单个 sitemap（一组链接）的推送结果 */
export interface PushGroupResult {
  success: number;
  remain: number;
  sent: number;
  unsent: number;
  quotaExhausted: boolean;
  requests: number;
  items: PushItem[];
}

export const PUSH_STATUS_TEXT: Record<PushItemStatus, string> = {
  success: '成功',
  not_same_site: '失败：非本站链接',
  not_valid: '失败：链接不合法',
  rejected: '失败：百度未确认接收',
  quota: '未提交：当日配额已用尽',
  duplicate: '未重复提交：已在其它 sitemap 中提交',
  error: '未提交：接口报错',
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
 * 把百度返回的英文错误码翻译成可读的中文提示
 */
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
  const endpoint = `${baiduEndpoint()}?site=${encodeURIComponent(site)}&token=${encodeURIComponent(token)}`;
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
 * 提交一组链接（通常是一个 sitemap 的全部链接）。
 *
 * 关键点：百度会整批校验剩余额度——只要本次提交的条数超过当天剩余额度（remain），
 * 整批都会被拒绝并返回 "over quota"，而不是部分接收。因此这里先用 1 条做探测，
 * 拿到真实 remain 后，再按 min(2000, remain) 分批提交。
 *
 * 该函数不会因为额度用尽而抛错：剩余的链接会被标记为 quota（未提交）后正常返回，
 * 这样调用方可以继续提交下一组（下一个 sitemap）。
 */
export async function pushUrlGroup(
  site: string,
  token: string,
  urls: string[],
  options: { sitemap?: string; initialRemain?: number } = {},
): Promise<PushGroupResult> {
  const items: PushItem[] = [];
  const normalizedSite = normalizeSite(site);
  const label = options.sitemap;

  if (urls.length === 0) {
    return {
      success: 0,
      remain: options.initialRemain ?? 0,
      sent: 0,
      unsent: 0,
      quotaExhausted: false,
      requests: 0,
      items,
    };
  }

  let remain = options.initialRemain ?? 0;
  let requests = 0;
  let success = 0;
  let sent = 0;
  let quotaExhausted = false;
  let cursor = 0;

  while (cursor < urls.length) {
    // 探测阶段只发 1 条，用于拿到当天剩余额度；之后按剩余额度分批。
    const size = requests === 0 ? PROBE_SIZE : Math.min(BAIDU_BATCH_SIZE, remain);
    const batchSize = Math.max(1, Math.min(size, urls.length - cursor));
    const batch = urls.slice(cursor, cursor + batchSize);

    let raw: RawResponse;
    try {
      raw = await postBatch(normalizedSite, token, batch);
    } catch (error) {
      if (error instanceof BaiduError && error.result?.quotaExhausted) {
        // 额度不足：这一批及其之后的链接都没有被百度接收（不抛错，交给调用方继续下一组）
        quotaExhausted = true;
        sent = cursor;
        for (const url of urls.slice(cursor)) {
          items.push({ url, status: 'quota', message: PUSH_STATUS_TEXT.quota, sitemap: label });
        }
        break;
      }
      throw error;
    }

    requests += 1;
    sent += batch.length;
    cursor += batch.length;

    const { payload } = raw;
    const batchSuccess = typeof payload.success === 'number' ? payload.success : 0;
    success += batchSuccess;
    remain = typeof payload.remain === 'number' ? payload.remain : remain;

    const batchNotSame = Array.isArray(payload.not_same_site) ? (payload.not_same_site as string[]) : [];
    const batchNotValid = Array.isArray(payload.not_valid) ? (payload.not_valid as string[]) : [];

    // 逐条归因：百度只回传失败明细，成功的是「总数」，
    // 因此用失败清单做差集，剩下的链接按 success 条数依次标记为成功。
    const notSameSet = new Set(batchNotSame);
    const notValidSet = new Set(batchNotValid);
    const pending: string[] = [];

    for (const url of batch) {
      if (notValidSet.has(url)) {
        items.push({ url, status: 'not_valid', message: PUSH_STATUS_TEXT.not_valid, sitemap: label });
      } else if (notSameSet.has(url)) {
        items.push({ url, status: 'not_same_site', message: PUSH_STATUS_TEXT.not_same_site, sitemap: label });
      } else {
        pending.push(url);
      }
    }

    pending.forEach((url, index) => {
      if (index < batchSuccess) {
        items.push({ url, status: 'success', message: PUSH_STATUS_TEXT.success, sitemap: label });
      } else {
        items.push({ url, status: 'rejected', message: PUSH_STATUS_TEXT.rejected, sitemap: label });
      }
    });

    if (remain <= 0) {
      quotaExhausted = true;
      for (const url of urls.slice(cursor)) {
        items.push({ url, status: 'quota', message: PUSH_STATUS_TEXT.quota, sitemap: label });
      }
      break;
    }
  }

  return {
    success,
    remain,
    sent,
    unsent: urls.length - sent,
    quotaExhausted,
    requests,
    items,
  };
}

/**
 * 一次性提交所有链接（不分组）。若需要「按 sitemap 分组提交」，请使用 pushUrlGroup。
 */
export async function pushUrls(site: string, token: string, urls: string[]): Promise<BaiduPushResult> {
  if (urls.length === 0) {
    throw new BaiduError('没有可推送的链接（解析结果为空，或全部被站点过滤规则过滤掉了）', 400);
  }

  const group = await pushUrlGroup(site, token, urls);

  return {
    success: group.success,
    remain: group.remain,
    notSameSite: group.items
      .filter((item) => item.status === 'not_same_site')
      .map((item) => item.url),
    notValid: group.items.filter((item) => item.status === 'not_valid').map((item) => item.url),
    sent: group.sent,
    unsent: group.unsent,
    quotaExhausted: group.quotaExhausted,
    requests: group.requests,
    items: group.items,
    status: 200,
  };
}
