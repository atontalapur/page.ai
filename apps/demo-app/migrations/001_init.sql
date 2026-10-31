create table products (
  id serial primary key,
  slug text not null unique,
  name text not null,
  description text not null default '',
  price_cents integer not null check (price_cents >= 0),
  stock integer not null check (stock >= 0),
  created_at timestamptz not null default now()
);

create table carts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create table cart_items (
  cart_id uuid not null references carts (id) on delete cascade,
  product_id integer not null references products (id),
  quantity integer not null check (quantity > 0),
  primary key (cart_id, product_id)
);

create table orders (
  id serial primary key,
  subtotal_cents integer not null check (subtotal_cents >= 0),
  shipping_cents integer not null check (shipping_cents >= 0),
  total_cents integer not null check (total_cents >= 0),
  status text not null default 'placed' check (status in ('placed', 'cancelled')),
  created_at timestamptz not null default now()
);

create table order_items (
  order_id integer not null references orders (id) on delete cascade,
  product_id integer not null references products (id),
  quantity integer not null check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  primary key (order_id, product_id)
);
