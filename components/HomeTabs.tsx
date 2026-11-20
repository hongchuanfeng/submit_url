'use client';

import { useState } from 'react';
import SubmitForm from '@/components/SubmitForm';
import UrlSubmitForm from '@/components/UrlSubmitForm';

type TabKey = 'sitemap' | 'urls';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'sitemap', label: 'sitemap 提交' },
  { key: 'urls', label: 'URL 批量提交' },
];

interface HomeTabsProps {
  defaultSite: string;
  hasDefaultToken: boolean;
}

export default function HomeTabs({ defaultSite, hasDefaultToken }: HomeTabsProps) {
  const [tab, setTab] = useState<TabKey>('sitemap');

  return (
    <>
      <div className="tabs" role="tablist" aria-label="提交方式">
        {TABS.map((item) => (
          <button
            key={item.key}
            role="tab"
            aria-selected={tab === item.key}
            className={`tab ${tab === item.key ? 'active' : ''}`}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'sitemap' ? (
        <SubmitForm defaultSite={defaultSite} hasDefaultToken={hasDefaultToken} />
      ) : (
        <UrlSubmitForm defaultSite={defaultSite} hasDefaultToken={hasDefaultToken} />
      )}
    </>
  );
}
