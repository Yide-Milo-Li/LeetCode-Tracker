/** Deterministic fictional catalog for public promotional screenshots; no private input or network. */
export const socialPracticeIds = [
  '1', '70', '322', '206', '21', '141', '102', '15', '53', '121',
  '238', '200', '300', '198', '11', '33', '3', '5', '76', '23',
  '42', '146', '207', '210', '295', '98', '105', '124', '199', '230',
  '543', '572', '621', '739', '84', '853', '981',
];

/** Build stable synthetic identifiers so every seeded practice and note has a matching problem. */
export function createSocialCatalog(): string {
  const tags = ['array', 'dynamic-programming', 'tree', 'graph-theory', 'hash-table', 'binary-search'];
  return Array.from({ length: 4046 }, (_, index) => {
    const id = index + 1;
    return JSON.stringify({
      id: String(id),
      title: 'Synthetic ' + tags[index % tags.length] + ' exercise ' + id,
      titleSlug: 'synthetic-exercise-' + id,
      url: 'https://example.invalid/synthetic-exercise-' + id,
      difficulty: ['Easy', 'Medium', 'Hard'][index % 3],
      tags: [tags[index % tags.length]],
    });
  }).join('\n');
}
