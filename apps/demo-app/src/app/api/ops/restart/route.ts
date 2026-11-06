import { postRestart } from '../../../../ops/api.ts';
import { opsDeps } from '../deps.ts';

export function POST(req: Request) {
  return postRestart(req, opsDeps());
}
