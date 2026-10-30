import { getDb } from '../../../db/index.ts';
import { checkHealth } from './health.ts';

// Goes straight to the database, not through shop(), so a bad shop setting can't fail
// the deploy healthcheck.
export function GET() {
  return checkHealth(getDb());
}
