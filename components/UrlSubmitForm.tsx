'use client';

import { useMemo, useState } from 'react';

interface UrlSubmitFormProps {
  defaultSite: string;
  hasDefaultToken: boolean;
}

type UrlItemStatus =
  | 'success'
  | 'not_same_site'
  | 'not_valid'
  | 'rejected'
  | 'quota'
  | 'duplicate'
  | 'error';

interface UrlItem {
  url: string;
  status: UrlItemStatus;
  message: string;
}

interface UrlSubmitResult {
  ok: boolean;
  error?: string;
  warning?: string;
  dryRun?: boolean;
  site?: string;
  siteSource?: 'input' | 'derived' | 'fallback';
  sites?: string[];
  total?: number;
  inputCount?: number;
  kept?: number;
  removed?: number;
  invalid?: number;
  duplicate?: number;
  hosts?: Array<{ host: string; count: number }>;
  preview?: string[];
  items?: UrlItem[];
  successCount?: number;
  failedCount?: number;
  duplicateCount?: number;
  success?: number;
  remain?: number;
  sent?: number;
  unsent?: number;
  quotaExhausted?: boolean;
  requests?: number;
  status?: number;
}

const STATUS_LABEL: Record<UrlItemStatus, string> = {
  success: '成功',
  not_same_site: '失败',
  not_valid: '失败',
  rejected: '失败',
  quota: '未提交',
  duplicate: '重复',
  error: '未提交',
};

type Filter = 'all' | 'success' | 'failed';

export default function UrlSubmitForm({ defaultSite, hasDefaultToken }: UrlSubmitFormProps) {
  const [urlText, setUrlText] = useState('');
  const [site, setSite] = useState(defaultSite);
  const [token, setToken] = useState('');
  const [filterSameSite, setFilterSameSite] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<UrlSubmitResult | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  const urlLines = useMemo(
    () =>
      urlText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    [urlText],
  );

  async function submit(dryRun: boolean) {
    setLoading(true);
    setResult(null);
    setFilter('all');

    try {
      const response = await fetch('/api/submit-urls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: urlLines,
          site,
          token: token || undefined,
          dryRun,
          filterSameSite,
        }),
      });
      const data = (await response.json()) as UrlSubmitResult;
      setResult(data);
    } catch (error) {
      setResult({ ok: false, error: `提交失败：${(error as Error).message ?? '网络错误'}` });
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
          <label htmlFor="urlList">
            要提交的 URL
            <span className="hint">必填，每行一个；重复的链接只会提交一次</span>
          </label>
          <textarea
            id="urlList"
            rows={10}
            placeholder={'https://www.example.com/page-1\nhttps://www.example.com/page-2'}
            value={urlText}
            onChange={(event) => setUrlText(event.target.value)}
          />
          <div className="hint-text">
            已填写 {urlLines.length} 条 URL
            {urlLines.length > 1 ? '（单次推送最多 2000 条，超出后自动分批）' : ''}
          </div>
        </div>

        <div className="row">
          <div className="field">
            <label htmlFor="site">
              站点 site
              <span className="hint">可留空，自动取填写内容中出现最多的域名</span>
            </label>
            <input
              id="site"
              type="text"
              placeholder="留空自动推断，如 www.example.com"
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
          <button className="ghost" disabled={loading || urlLines.length === 0} onClick={() => submit(true)}>
            仅校验预览
          </button>
          <button
            className="primary"
            disabled={loading || urlLines.length === 0}
            onClick={() => submit(false)}
          >
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

          <div className="stats">
            <div className="stat">
              <div className="label">推送站点 site</div>
              <div className="value value-site">
                {result.site || '—'}
                {result.siteSource === 'derived' ? <span className="inline-tag">自动推断</span> : null}
              </div>
            </div>
            <div className="stat">
              <div className="label">填写条数</div>
              <div className="value">{result.inputCount ?? urlLines.length}</div>
            </div>
            <div className="stat">
              <div className="label">去重后条数</div>
              <div className="value">{result.total ?? 0}</div>
            </div>
            <div className="stat">
              <div className="label">待提交条数</div>
              <div className="value">{result.kept ?? 0}</div>
            </div>
            {result.dryRun ? (
              <div className="stat">
                <div className="label">非法链接</div>
                <div className="value bad">{result.invalid ?? 0}</div>
              </div>
            ) : (
              <>
                <div className="stat">
                  <div className="label">推送成功</div>
                  <div className="value ok">{result.successCount ?? 0}</div>
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
            {result.duplicate ? (
              <div className="stat">
                <div className="label">重复链接</div>
                <div className="value warn">{result.duplicate}</div>
              </div>
            ) : null}
          </div>

          {result.hosts && result.hosts.length > 0 ? (
            <>
              <p className="subtitle">URL 域名分布</p>
              <div className="url-list">
                {result.hosts.map((item) => `${item.host}  ×  ${item.count}`).join('\n')}
              </div>
            </>
          ) : null}

          {result.dryRun && result.preview && result.preview.length > 0 ? (
            <>
              <p className="subtitle">将提交的链接（前 {result.preview.length} 条）</p>
              <div className="url-list">{result.preview.join('\n')}</div>
            </>
          ) : null}

          {items.length > 0 ? (
            <>
              <p className="subtitle">
                逐条结果（共 {items.length} 条：成功 {result.successCount ?? 0} 条，失败{' '}
                {result.failedCount ?? 0} 条，未提交{' '}
                {items.filter((item) => item.status === 'quota' || item.status === 'error').length}{' '}
                条，重复 {result.duplicateCount ?? 0} 条）
              </p>

              <div className="filter-bar">
                <button className={filter === 'all' ? 'chip active' : 'chip'} onClick={() => setFilter('all')}>
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
                  失败 / 未提交{' '}
                  {items.filter((item) => item.status !== 'success' && item.status !== 'duplicate').length}
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

          {!result.dryRun && result.ok && !result.quotaExhausted ? (
            <div className="alert success">推送完成，结果以百度接口返回为准。</div>
          ) : null}
        </section>
      )}
    </>
  );
}
