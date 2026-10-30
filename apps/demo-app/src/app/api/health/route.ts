import { getDb } from '../../../db/index.ts';
import { checkHealth } from './health.ts';

export function GET() {
  return checkHealth(getDb());
}
