// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { ThemeProvider } from '@page/design-system/components/theme-provider';

import DashboardLayout from './DashboardLayout';

// jsdom has no matchMedia; the sidebar's useIsMobile hook subscribes to it.
beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderLayout(path: string) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <DashboardLayout>
          <p>content</p>
        </DashboardLayout>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('DashboardLayout', () => {
  it('renders each sidebar item as a link, not a link inside a button', () => {
    renderLayout('/');

    for (const [name, href] of [
      ['Dashboard', '/'],
      ['Incidents', '/incidents'],
      ['Agents', '/agents'],
      ['Knowledge', '/knowledge'],
      ['Debugging', '/debug'],
      ['Settings', '/settings'],
    ]) {
      const link = screen.getByRole('link', { name });

      expect(link.getAttribute('href')).toBe(href);
      expect(link.closest('button')).toBeNull();
      expect(link.querySelector('a, button')).toBeNull();
    }
  });

  it('marks the current section active', () => {
    renderLayout('/incidents/INC-001');

    expect(screen.getByRole('link', { name: 'Incidents' }).hasAttribute('data-active')).toBe(true);
    expect(screen.getByRole('link', { name: 'Agents' }).hasAttribute('data-active')).toBe(false);
  });

  it('puts the logo, linking home, and the theme switch in the top bar on any route', () => {
    renderLayout('/does-not-exist');

    expect(screen.getByRole('link', { name: 'Page.AI home' }).getAttribute('href')).toBe('/');
    expect(screen.getByRole('group', { name: 'Theme' })).toBeTruthy();
  });
});
