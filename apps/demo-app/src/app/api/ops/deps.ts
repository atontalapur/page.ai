import { getDb } from '../../../db/index.ts';
import type { OpsDeps } from '../../../ops/api.ts';
import { processRestarter } from '../../../ops/restart.ts';
import { loadedSettings } from '../../data.ts';

const restarter = processRestarter();

// Straight to the database, not through shop(), so a bad shop setting can't lock out the
// API that fixes it.
export function opsDeps(): OpsDeps {
  return { db: getDb(), env: process.env, loaded: loadedSettings(), restarter };
}
