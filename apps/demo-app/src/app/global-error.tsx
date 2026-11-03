'use client';

import { useEffect } from 'react';
import { reportBoundaryError } from '../observability/client.ts';

/** Last-resort boundary. Reports browser errors; server ones were reported on the server. */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    reportBoundaryError(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <h1>Something went wrong</h1>
        <button type="button" onClick={() => retry()}>
          Try again
        </button>
      </body>
    </html>
  );
}
