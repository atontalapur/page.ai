'use client';

import { useEffect } from 'react';
import type { ReportingConfig } from '../observability/config.ts';
import { initClientReporting } from '../observability/client.ts';

/** Starts browser error reporting once the page hydrates. Renders nothing. */
export function ErrorReporting({ config }: { config: ReportingConfig }) {
  useEffect(() => {
    initClientReporting(config);
  }, [config]);
  return null;
}
