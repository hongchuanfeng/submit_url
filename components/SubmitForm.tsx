'use client';

import { useMemo, useState } from 'react';

interface SubmitFormProps {
  defaultSite: string;
  hasDefaultToken: boolean;
}

type PushItemStatus = 'success' | 'not_same_site' | 'not_valid' | 'rejected' | 'quota';

interface PushItem {
  url: string;
  status: PushItemStatus;
  message: string;
}

interface SubmitResult {
  ok: boolean;
  error?: string;
  warning?: string;
  dryRun?: boolean;
  site?: string;
  total?: number;
  kept?: number;
  removed?: number;
  isIndex?: boolean;
  childSitemaps?: number;
  skipped?: string[];
  hosts?: Array<{ host: string; count: number }>;
  preview?: string[];
  success?: number;
  remain?: number;
  sent?: number;
  unsent?: number;
  quotaExhausted?: boolean;
  requests?: number;
  items?: PushItem[];
  successCount?: number;
  failedCount?: number;
  notSameSite?: string[];
  notValid?: string[];
  status?: number;
}

const STATUS_LABEL: Record<PushItemStatus, string> = {
  success: '成功',
  not_same_site: '失败',
  not_valid: '失败',
  rejected: '失败',
  quota: '未提交',
};

type Filter = 'all' | 'success' | 'failed';

export default function SubmitForm({ defaultSite, hasDefaultToken }: SubmitFormProps) {
  const [sitemapUrl, setSitemapUrl] = useState('');
  const [site, setSite] = useState(defaultSite);
  const [token, setToken] = useState('');
  const [filterSameSite, setFilterSameSite] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  async function submit(dryRun: boolean) {
    setLoading(true);
    setResult(null);
    try {
      const response = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sitemapUrl,
          site,
          token: token || undefined,
          dryRun,
          filterSameSite,
        }),
      });
      const data = (await response.json()) as SubmitResult;
      setResult(data);
      setFilter('all');
    } catch (error) {
      setResult({ ok: false, error: `请求失败：${(error as Error).message}` });
    } finally {
      setLoading(false);
    }
  }

  const items = result?.items ?? [];
  const visibleItems = useMemo(() => {
    if (filter === 'success') return items.filter((item) => item.status === 'success');
    if (filter === 'failed') return items.filter((item) => item.status !== 'success');
    return items;
  }, [items, filter]);

  const failed = result && result.ok === false;

  return (
    <>
      <section className="card">
        <h2>提交参数</h2>

        <div className="field">
          <label htmlFor="sitemapUrl">
            sitemap 地址<span className="hint">必填，支持 sitemap 索引与 .xml.gz</span>
          </label>
          <input
            id="sitemapUrl"
            type="text"
            placeholder="https://www.example.com/sitemap.xml"
            value={sitemapUrl}
            onChange={(event) => setSitemapUrl(event.target.value)}
          />
        </div>

        <div className="row">
          <div className="field">
            <label htmlFor="site">
              站点 site
              <span className="hint">裸域名，如 www.example.com（不要带 http://）</span>
            </label>
            <input
              id="site"
              type="text"
              placeholder="www.example.com"
              value={site}
              onChange={(event) => setSite(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="token">
              推送 token
              <span className="hint">
                {hasDefaultToken ? '留空则使用服务端环境变量' : '在搜索资源平台申请'}
              </span>
            </label>
            <input
              id="token"
              type="password"
              placeholder={hasDefaultToken ? '使用环境变量中的 token' : 'xxxxxxxxxxxxxxxx'}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </div>
        </div>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={filterSameSite}
            onChange={(event) => setFilterSameSite(event.target.checked)}
          />
          过滤掉与 site 不同域名的链接
        </label>

        <div className="actions">
          <button className="ghost" disabled={loading || !sitemapUrl} onClick={() => submit(true)}>
            仅解析预览
          </button>
          <button className="primary" disabled={loading || !sitemapUrl} onClick={() => submit(false)}>
            {loading ? '处理中…' : '开始提交'}
          </button>
        </div>
      </section>

      {result && (
        <section className="card">
          <h2>执行结果</h2>

          {failed ? (
            <div className="alert error">
              {result.error ?? '执行失败'}
              {result.status ? `（HTTP ${result.status}）` : ''}
            </div>
          ) : null}

          {result.warning ? <div className="alert warn">{result.warning}</div> : null}

          {result && !failed ? (
            <>
              <div className="stats">
                <div className="stat">
                  <div className="label">解析链接总数</div>
                  <div className="value">{result.total ?? 0}</div>
                </div>
                <div className="stat">
                  <div className="label">待提交条数</div>
                  <div className="value">{result.kept ?? 0}</div>
                </div>
                {result.dryRun ? (
                  <div className="stat">
                    <div className="label">被过滤（非本站）</div>
                    <div className="value warn">{result.removed ?? 0}</div>
                  </div>
                ) : (
                  <>
                    <div className="stat">
                      <div className="label">推送成功</div>
                      <div className="value ok">{result.successCount ?? result.success ?? 0}</div>
                    </div>
                    <div className="stat">
                      <div className="label">推送失败</div>
                      <div className="value bad">{result.failedCount ?? 0}</div>
                    </div>
                    <div className="stat">
                      <div className="label">当天剩余额度</div>
                      <div className={`value ${result.quotaExhausted ? 'bad' : ''}`}>
                        {result.remain ?? 0}
                      </div>
                    </div>
                  </>
                )}
                {result.removed ? (
                  <div className="stat">
                    <div className="label">被过滤（非本站）</div>
                    <div className="value warn">{result.removed}</div>
                  </div>
                ) : null}
              </div>

              {result.hosts && result.hosts.length > 0 ? (
                <>
                  <p className="subtitle">sitemap 链接域名分布</p>
                  <div className="url-list">
                    {result.hosts.map((item) => `${item.host}  ×  ${item.count}`).join('\n')}
                  </div>
                </>
              ) : null}

              {result.isIndex ? (
                <p className="subtitle">
                  检测到 sitemap 索引，已展开 {result.childSitemaps ?? 0} 个子 sitemap。
                </p>
              ) : null}

              {result.skipped && result.skipped.length > 0 ? (
                <p className="subtitle">
                  以下子 sitemap 超出抓取限制被跳过：{result.skipped.join('、')}
                </p>
              ) : null}

              {result.dryRun && result.preview && result.preview.length > 0 ? (
                <>
                  <p className="subtitle">链接预览（前 {result.preview.length} 条）</p>
                  <div className="url-list">{result.preview.join('\n')}</div>
                </>
              ) : null}

              {!result.dryRun && items.length > 0 ? (
                <>
                  <p className="subtitle">
                    逐条结果（共 {items.length} 条：成功 {result.successCount ?? 0} 条，失败{' '}
                    {result.failedCount ?? 0} 条）
                  </p>

                  <div className="filter-bar">
                    <button
                      className={filter === 'all' ? 'chip active' : 'chip'}
                      onClick={() => setFilter('all')}
                    >
                      全部 {items.length}
                    </button>
                    <button
                      className={filter === 'success' ? 'chip active' : 'chip'}
                      onClick={() => setFilter('success')}
                    >
                      成功 {items.filter((item) => item.status === 'success').length}
                    </button>
                    <button
                      className={filter === 'failed' ? 'chip active' : 'chip'}
                      onClick={() => setFilter('failed')}
                    >
                      失败 / 未提交 {items.filter((item) => item.status !== 'success').length}
                    </button>
                  </div>

                  <ul className="result-list">
                    {visibleItems.map((item, index) => (
                      <li key={`${item.url}-${index}`} className={`result-item ${item.status}`}>
                        <span className="badge">{STATUS_LABEL[item.status]}</span>
                        <span className="result-url">{item.url}</span>
                        <span className="result-message">{item.message}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {!result.dryRun && !result.quotaExhausted ? (
                <div className="alert success">推送完成，结果以百度接口返回为准。</div>
              ) : null}
            </>
          ) : null}
        </section>
      )}
    </>
  );
}
