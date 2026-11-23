// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import IncidentsPage from './IncidentsPage';
import { mockIncidents } from '../data/mockIncidents';

afterEach(() => {
  cleanup();
});

function renderIncidentsPage() {
  return render(
    <MemoryRouter>
      <IncidentsPage />
    </MemoryRouter>,
  );
}

function getIncidentRows() {
  return screen.getAllByRole('row').slice(1);
}

describe('IncidentsPage', () => {
  it('renders the page heading', () => {
    renderIncidentsPage();

    expect(screen.getByRole('heading', { name: 'Incidents' })).toBeTruthy();

    expect(screen.getByText('Monitor detected errors and track AI investigations.')).toBeTruthy();
  });

  it('renders all four metric cards', () => {
    renderIncidentsPage();

    const metricLabels = [
      'Total Incidents',
      'Active Incidents',
      'Critical Incidents',
      'Awaiting Approval',
    ];

    for (const label of metricLabels) {
      expect(
        screen.getByText(label, {
          selector: '[data-slot="card-title"]',
        }),
      ).toBeTruthy();
    }
  });

  it('displays the correct metric values', () => {
    renderIncidentsPage();

    const expectedMetrics = {
      'Total Incidents': mockIncidents.length,

      'Active Incidents': mockIncidents.filter((incident) => incident.status !== 'Resolved').length,

      'Critical Incidents': mockIncidents.filter((incident) => incident.severity === 'Critical')
        .length,

      'Awaiting Approval': mockIncidents.filter(
        (incident) => incident.status === 'Awaiting Approval',
      ).length,
    };

    for (const [label, value] of Object.entries(expectedMetrics)) {
      const metricTitle = screen.getByText(label, {
        selector: '[data-slot="card-title"]',
      });

      const card = metricTitle.closest('[data-slot="card"]');

      expect(card).not.toBeNull();

      expect(within(card as HTMLElement).getByText(String(value))).toBeTruthy();
    }
  });

  it('renders every incident in the table', () => {
    renderIncidentsPage();

    const rows = getIncidentRows();

    expect(rows).toHaveLength(mockIncidents.length);

    for (const incident of mockIncidents) {
      expect(
        screen.getByRole('link', {
          name: new RegExp(incident.id),
        }),
      ).toBeTruthy();
    }
  });

  it('displays the initial incident count', () => {
    renderIncidentsPage();

    expect(screen.getByText(`${mockIncidents.length} incidents found`)).toBeTruthy();
  });

  it('filters incidents by title', () => {
    renderIncidentsPage();

    const incident = mockIncidents[0]!;

    fireEvent.change(screen.getByPlaceholderText('Search incidents...'), {
      target: { value: incident.title },
    });

    const expected = mockIncidents.filter((item) =>
      item.title.toLowerCase().includes(incident.title.toLowerCase()),
    );

    expect(getIncidentRows()).toHaveLength(expected.length);

    expect(
      screen.getByRole('link', {
        name: new RegExp(incident.id),
      }),
    ).toBeTruthy();
  });

  it('filters incidents by ID', () => {
    renderIncidentsPage();

    const incident = mockIncidents[0]!;

    fireEvent.change(screen.getByPlaceholderText('Search incidents...'), {
      target: { value: incident.id },
    });

    expect(getIncidentRows()).toHaveLength(1);

    expect(
      screen.getByRole('link', {
        name: new RegExp(incident.id),
      }),
    ).toBeTruthy();
  });

  it('filters incidents by status', () => {
    renderIncidentsPage();

    fireEvent.change(
      screen.getByRole('combobox', {
        name: 'Filter by status',
      }),
      {
        target: { value: 'Investigating' },
      },
    );

    const expected = mockIncidents.filter((incident) => incident.status === 'Investigating');

    expect(getIncidentRows()).toHaveLength(expected.length);

    for (const row of getIncidentRows()) {
      expect(within(row).getByText('Investigating')).toBeTruthy();
    }
  });

  it('filters incidents by severity', () => {
    renderIncidentsPage();

    fireEvent.change(
      screen.getByRole('combobox', {
        name: 'Filter by severity',
      }),
      {
        target: { value: 'Critical' },
      },
    );

    const expected = mockIncidents.filter((incident) => incident.severity === 'Critical');

    expect(getIncidentRows()).toHaveLength(expected.length);

    for (const row of getIncidentRows()) {
      expect(within(row).getByText('Critical')).toBeTruthy();
    }
  });

  it('combines status and severity filters', () => {
    renderIncidentsPage();

    fireEvent.change(
      screen.getByRole('combobox', {
        name: 'Filter by status',
      }),
      {
        target: { value: 'Investigating' },
      },
    );

    fireEvent.change(
      screen.getByRole('combobox', {
        name: 'Filter by severity',
      }),
      {
        target: { value: 'Critical' },
      },
    );

    const expected = mockIncidents.filter(
      (incident) => incident.status === 'Investigating' && incident.severity === 'Critical',
    );

    expect(screen.getByText(`${expected.length} incidents found`)).toBeTruthy();

    if (expected.length > 0) {
      expect(getIncidentRows()).toHaveLength(expected.length);
    } else {
      expect(screen.getByText('No incidents match your filters.')).toBeTruthy();
    }
  });

  it('displays an empty state when no incidents match', () => {
    renderIncidentsPage();

    fireEvent.change(screen.getByPlaceholderText('Search incidents...'), {
      target: { value: 'nonexistent-incident-xyz' },
    });

    expect(screen.getByText('No incidents match your filters.')).toBeTruthy();

    expect(screen.getByText('0 incidents found')).toBeTruthy();
  });

  it('gives severity and status badges dark mode variants', () => {
    renderIncidentsPage();

    const firstRow = getIncidentRows()[0]!;
    const incident = mockIncidents[0]!;

    expect(within(firstRow).getByText(incident.severity).className).toMatch(/dark:bg-\w+-950/);
    expect(within(firstRow).getByText(incident.status).className).toMatch(/dark:bg-\w+-950/);
  });

  it('renders correct navigation links for incidents', () => {
    renderIncidentsPage();

    for (const incident of mockIncidents) {
      const link = screen.getByRole('link', {
        name: new RegExp(incident.id),
      });

      expect(link.getAttribute('href')).toBe(`/incidents/${incident.id}`);
    }
  });
});
