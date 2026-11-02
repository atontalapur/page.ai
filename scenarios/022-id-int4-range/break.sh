#!/bin/sh
# idSchema is tidied to z.number().int().positive(), dropping the int4 upper bound. An id
# past 2147483647 now passes validation and reaches Postgres, which throws "out of range
# for type integer", so /orders/3000000000 is a 500 instead of a 404.
set -eu
f=apps/demo-app/src/app/ids.ts
sed -i 's/export const idSchema = z.number().int().min(1).max(2_147_483_647);/export const idSchema = z.number().int().positive();/' "$f"
grep -q 'export const idSchema = z.number().int().positive();' "$f"
