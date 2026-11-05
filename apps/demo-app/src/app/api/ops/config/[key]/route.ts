import { deleteConfig, putConfig } from '../../../../../ops/api.ts';
import { opsDeps } from '../../deps.ts';

export async function PUT(req: Request, ctx: RouteContext<'/api/ops/config/[key]'>) {
  return putConfig(req, (await ctx.params).key, opsDeps());
}

export async function DELETE(req: Request, ctx: RouteContext<'/api/ops/config/[key]'>) {
  return deleteConfig(req, (await ctx.params).key, opsDeps());
}
