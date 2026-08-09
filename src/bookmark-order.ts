export type BookmarkSortDirection = 'asc' | 'desc';

export function hasXOrderSql(alias = 'b'): string {
  const column = `${alias}.sort_index`;
  return `${column} IS NOT NULL AND ${column} <> '' AND ${column} NOT GLOB '*[^0-9]*'`;
}

export function bookmarkSortClause(
  direction: BookmarkSortDirection = 'desc',
  alias = 'b',
): string {
  const normalized = direction === 'asc' ? 'ASC' : 'DESC';
  const hasXOrder = hasXOrderSql(alias);
  const sortIndex = `${alias}.sort_index`;
  const bookmarkedAt = `${alias}.bookmarked_at`;
  const postedAt = `${alias}.posted_at`;
  const tweetId = `${alias}.tweet_id`;

  return `
    ORDER BY
      CASE WHEN ${hasXOrder} THEN 0 ELSE 1 END ASC,
      CASE WHEN ${hasXOrder} THEN length(${sortIndex}) ELSE 0 END ${normalized},
      CASE WHEN ${hasXOrder} THEN ${sortIndex} ELSE '' END COLLATE BINARY ${normalized},
      CASE
        WHEN ${bookmarkedAt} GLOB '____-__-__*' THEN ${bookmarkedAt}
        WHEN ${postedAt} GLOB '____-__-__*' THEN ${postedAt}
        ELSE ''
      END ${normalized},
      length(${tweetId}) ${normalized},
      ${tweetId} COLLATE BINARY ${normalized}
  `;
}
