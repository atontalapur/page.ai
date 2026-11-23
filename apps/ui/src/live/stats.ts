import { useEffect, useState } from 'react';
import { spendStatsSchema, type SpendStats } from '@page/contracts';

import { readToken } from './token';

/** Model spend over every session, loaded again whenever `key` changes. */
export function useSpend(key: string): SpendStats | undefined {
  const [spend, setSpend] = useState<SpendStats | undefined>();
  useEffect(() => {
    let live = true;
    fetch('/stats/spend', {
      headers: { authorization: `Bearer ${readToken() ?? ''}`, accept: 'application/json' },
    })
      .then(async (res) => (res.ok ? spendStatsSchema.parse(await res.json()) : undefined))
      .then(
        (s) => live && s && setSpend(s),
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [key]);
  return spend;
}
