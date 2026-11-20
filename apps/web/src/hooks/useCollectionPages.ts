import { useMemo, useState } from 'react';

export interface NamedCollection {
  id: string;
  name: string;
}

const normalize = (name: string) => name.trim().normalize('NFKC').toLowerCase();

export function useCollectionPages<T extends NamedCollection>(collections: readonly T[], pageSize: number, initialId?: string) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [anchor, setAnchor] = useState(initialId);
  const term = normalize(query);
  const matches = useMemo(() => term
    ? collections.filter(collection => normalize(collection.name).includes(term))
    : collections, [collections, term]);
  const anchoredIndex = anchor ? matches.findIndex(collection => collection.id === anchor) : -1;
  const currentPage = anchoredIndex >= 0
    ? Math.floor(anchoredIndex / pageSize) + 1
    : Math.min(page, Math.max(1, Math.ceil(matches.length / pageSize)));

  function goToPage(next: number) {
    setAnchor(undefined);
    setPage(next);
  }
  function search(next: string) {
    setQuery(next);
    goToPage(1);
  }
  // A saved list can move to a different page when the refreshed directory is sorted by name.
  function reveal(collection: NamedCollection) {
    if (term && !normalize(collection.name).includes(term)) setQuery('');
    setAnchor(collection.id);
  }

  return {
    query, search, reveal,
    items: matches.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    pagination: { page: currentPage, total: matches.length, limit: pageSize, onPage: goToPage },
  };
}
