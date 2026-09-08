/**
 * Catalog browsing, search, multi-dimensional filtering, and metrics view.
 */
import React, { useEffect, useState } from 'react';
import {
  Search,
  ExternalLink,
  FilterX,
  Database,
  Layers,
  Sparkles,
} from 'lucide-react';
import { api, type CatalogProblem, type CatalogStats, type TopicTag } from '../api.ts';
import { translations, type Language } from '../i18n.ts';

interface CatalogViewProps {
  lang: Language;
  onNavigateSettings: () => void;
}

export const CatalogView: React.FC<CatalogViewProps> = ({ lang, onNavigateSettings }) => {
  const t = translations[lang];

  const [stats, setStats] = useState<CatalogStats | null>(null);
  const [tags, setTags] = useState<TopicTag[]>([]);
  const [problems, setProblems] = useState<CatalogProblem[]>([]);
  const [total, setTotal] = useState(0);

  // Filters state
  const [search, setSearch] = useState('');
  const [difficulty, setDifficulty] = useState<string>('');
  const [tag, setTag] = useState<string>('');
  const [premium, setPremium] = useState<string>('all');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [loading, setLoading] = useState(false);

  // Load stats and tags on mount
  useEffect(() => {
    loadStats();
    loadTags();
  }, []);

  // Reload problems on filter changes
  useEffect(() => {
    loadProblems();
  }, [search, difficulty, tag, premium, page, limit]);

  async function loadStats() {
    try {
      const res = await api.getCatalogStats();
      setStats(res);
    } catch (err) {
      console.error('Failed to load stats:', err);
    }
  }

  async function loadTags() {
    try {
      const res = await api.getAllTags();
      setTags(res.tags);
    } catch (err) {
      console.error('Failed to load tags:', err);
    }
  }

  async function loadProblems() {
    setLoading(true);
    try {
      const res = await api.getCatalog({
        page,
        limit,
        search: search.trim() || undefined,
        difficulty: (difficulty as any) || undefined,
        tag: tag || undefined,
        premium: (premium as any) || 'all',
      });
      setProblems(res.items);
      setTotal(res.total);
    } catch (err) {
      console.error('Failed to load problems:', err);
    } finally {
      setLoading(false);
    }
  }

  function handleResetFilters() {
    setSearch('');
    setDifficulty('');
    setTag('');
    setPremium('all');
    setPage(1);
  }

  const totalPages = Math.ceil(total / limit) || 1;

  // Format date helper
  const formattedLastImport = stats?.lastImportedAt
    ? new Date(stats.lastImportedAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')
    : t.never;

  // Safe external URL validator
  function getSafeUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.toString();
      }
    } catch {
      // invalid URL
    }
    return null;
  }

  return (
    <div>
      {/* Overview Metrics Cards */}
      <div className="metrics-grid">
        <div className="metric-card">
          <div className="metric-label">{t.statTotal}</div>
          <div className="metric-value">{stats?.totalProblems ?? 0}</div>
          <div className="metric-sub">{t.statRevision}: {stats?.catalogRevision ?? 0}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label" style={{ color: 'var(--easy)' }}>{t.statEasy}</div>
          <div className="metric-value" style={{ color: 'var(--easy)' }}>{stats?.easy ?? 0}</div>
          <div className="metric-sub">
            {stats?.totalProblems ? Math.round(((stats.easy / stats.totalProblems) * 100)) : 0}%
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label" style={{ color: 'var(--medium)' }}>{t.statMedium}</div>
          <div className="metric-value" style={{ color: 'var(--medium)' }}>{stats?.medium ?? 0}</div>
          <div className="metric-sub">
            {stats?.totalProblems ? Math.round(((stats.medium / stats.totalProblems) * 100)) : 0}%
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label" style={{ color: 'var(--hard)' }}>{t.statHard}</div>
          <div className="metric-value" style={{ color: 'var(--hard)' }}>{stats?.hard ?? 0}</div>
          <div className="metric-sub">
            {stats?.totalProblems ? Math.round(((stats.hard / stats.totalProblems) * 100)) : 0}%
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">{t.statPremium}</div>
          <div className="metric-value">{stats?.paidOnly ?? 0}</div>
          <div className="metric-sub">{t.statLastImport}: {formattedLastImport}</div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="card" style={{ padding: '1rem 1.25rem', marginBottom: '1rem' }}>
        <div className="filters-bar" style={{ marginBottom: 0 }}>
          <div style={{ position: 'relative', flex: '1 1 240px' }}>
            <Search size={16} style={{ position: 'absolute', left: 10, top: 11, color: 'var(--text-muted)' }} />
            <input
              type="text"
              className="input-field"
              style={{ width: '100%', paddingLeft: '2rem' }}
              placeholder={t.searchPlaceholder}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </div>

          <select
            className="select-field"
            value={difficulty}
            onChange={(e) => { setDifficulty(e.target.value); setPage(1); }}
          >
            <option value="">{t.allDifficulties}</option>
            <option value="Easy">Easy / 简单</option>
            <option value="Medium">Medium / 中等</option>
            <option value="Hard">Hard / 困难</option>
          </select>

          <select
            className="select-field"
            value={tag}
            onChange={(e) => { setTag(e.target.value); setPage(1); }}
            style={{ maxWidth: 200 }}
          >
            <option value="">{t.allTags}</option>
            {tags.map((tg) => (
              <option key={tg.slug} value={tg.slug}>{tg.name}</option>
            ))}
          </select>

          <select
            className="select-field"
            value={premium}
            onChange={(e) => { setPremium(e.target.value); setPage(1); }}
          >
            <option value="all">{t.allPricing}</option>
            <option value="false">{t.freeOnly}</option>
            <option value="true">{t.premiumOnly}</option>
          </select>

          {(search || difficulty || tag || premium !== 'all') && (
            <button className="btn btn-outline btn-sm" onClick={handleResetFilters} title="Reset filters">
              <FilterX size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Main Problems Table or Empty State */}
      {stats && stats.totalProblems === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '3.5rem 1.5rem' }}>
          <Database size={48} style={{ margin: '0 auto 1rem auto', color: 'var(--text-muted)' }} />
          <h3 className="card-title" style={{ justifyContent: 'center' }}>{t.noProblemsInDb}</h3>
          <p className="card-desc">{t.importPrompt}</p>
          <button className="btn btn-primary" onClick={onNavigateSettings}>
            <Sparkles size={16} />
            {t.navSettings}
          </button>
        </div>
      ) : problems.length === 0 && !loading ? (
        <div className="card" style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
          <Layers size={40} style={{ margin: '0 auto 0.75rem auto', color: 'var(--text-muted)' }} />
          <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>{t.noProblems}</p>
          <button className="btn btn-outline btn-sm" onClick={handleResetFilters}>
            {lang === 'zh' ? '清空筛选条件' : 'Clear Filters'}
          </button>
        </div>
      ) : (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: '80px' }}>{t.tableId}</th>
                <th>{t.tableTitle}</th>
                <th style={{ width: '110px' }}>{t.tableDifficulty}</th>
                <th>{t.tableTags}</th>
                <th style={{ width: '100px', textAlign: 'right' }}>{t.tableLink}</th>
              </tr>
            </thead>
            <tbody>
              {problems.map((p) => {
                const safeUrl = getSafeUrl(p.url);
                return (
                  <tr key={p.questionFrontendId}>
                    <td style={{ fontWeight: 600, color: 'var(--text-muted)' }}>
                      #{p.questionFrontendId}
                    </td>
                    <td>
                      <span style={{ fontWeight: 500 }}>{p.title}</span>
                      {p.isPaidOnly && (
                        <span className="badge badge-premium">PREMIUM</span>
                      )}
                    </td>
                    <td>
                      <span className={`badge badge-${p.difficulty.toLowerCase()}`}>
                        {p.difficulty}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                        {p.topicTags.slice(0, 4).map((tg) => (
                          <span key={tg.slug} className="badge badge-tag">
                            {tg.name}
                          </span>
                        ))}
                        {p.topicTags.length > 4 && (
                          <span className="badge badge-tag" title={p.topicTags.slice(4).map(t => t.name).join(', ')}>
                            +{p.topicTags.length - 4}
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {safeUrl ? (
                        <a
                          href={safeUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn btn-outline btn-sm"
                          style={{ textDecoration: 'none', display: 'inline-flex' }}
                        >
                          <span>{t.openLink}</span>
                        </a>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination Controls */}
      {total > 0 && (
        <div className="pagination-bar">
          <div style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
            {t.pageInfo
              .replace('{page}', String(page))
              .replace('{totalPages}', String(totalPages))
              .replace('{total}', String(total))}
          </div>
          <div className="pagination-controls">
            <select
              className="select-field"
              value={limit}
              onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}
              style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
            >
              <option value={20}>20 {t.perPage}</option>
              <option value={50}>50 {t.perPage}</option>
              <option value={100}>100 {t.perPage}</option>
            </select>
            <button
              className="btn btn-outline btn-sm"
              disabled={page <= 1}
              onClick={() => setPage((prev) => Math.max(1, prev - 1))}
            >
              {t.prev}
            </button>
            <button
              className="btn btn-outline btn-sm"
              disabled={page >= totalPages}
              onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
            >
              {t.next}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
