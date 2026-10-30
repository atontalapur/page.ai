import { shop } from '../../data.ts';
import { checkHealth } from './health.ts';

export async function GET() {
  const { db } = await shop();
  return checkHealth(db);
}
