// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeProvider } from '@page/design-system/components/theme-provider';
import App from './App';

describe('App', () => {
  it('renders the dashboard heading', () => {
    // main.tsx wraps the app in the theme provider; so does this test.
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    );

    expect(html).toContain('Page.AI');
    expect(html).toContain('Dashboard');
  });
});
