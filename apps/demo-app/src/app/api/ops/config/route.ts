import { getConfig } from '../../../../ops/api.ts';
import { opsDeps } from '../deps.ts';

export function GET(req: Request) {
  return getConfig(req, opsDeps());
}
