import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import RootLayout from './layout';
import HomePage from './page';

describe('app shell', () => {
  it('renders the home page inside the root layout', () => {
    const html = renderToStaticMarkup(
      <RootLayout>
        <HomePage />
      </RootLayout>,
    );
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<h1>Page Shop</h1>');
  });
});
