// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanup,
  render,
  screen,
  within,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import IncidentDetailsPage from './IncidentDetailsPage';
import { mockIncidents } from '../data/mockIncidents';

afterEach(() => {
  cleanup();
});

function renderIncidentDetails(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/incidents/${id}`]}>
      <Routes>
        <Route
          path="/incidents/:id"
          element={<IncidentDetailsPage />}
        />
      </Routes>
    </MemoryRouter>
  );
}

function getMetricCard(label: string) {
  const title = screen.getByText(label, {
    selector: '[data-slot="card-title"]',
  });

  const card = title.closest('[data-slot="card"]');

  if (!card) {
    throw new Error(`Metric card not found: ${label}`);
  }

  return within(card as HTMLElement);
}

describe('IncidentDetailsPage', () => {
  it('renders incident title and description', () => {
    const incident = mockIncidents[0]!;

    renderIncidentDetails(incident.id);

    expect(
      screen.getByRole('heading', { name: incident.title })
    ).toBeTruthy();

    expect(
      screen.getByText(incident.description)
    ).toBeTruthy();
  });

  it('displays the incident ID', () => {
    const incident = mockIncidents[0]!;

    renderIncidentDetails(incident.id);

    expect(screen.getByText(incident.id)).toBeTruthy();
  });

  it('displays severity and status badges', () => {
    const incident = mockIncidents[0]!;

    renderIncidentDetails(incident.id);

    const badges = document.querySelectorAll(
      '[data-slot="badge"]'
    );

    expect(badges).toHaveLength(2);

    expect(
      Array.from(badges).some(
        (badge) => badge.textContent === incident.severity
      )
    ).toBe(true);

    expect(
      Array.from(badges).some(
        (badge) => badge.textContent === incident.status
      )
    ).toBe(true);
  });

  it('displays the correct occurrence count', () => {
    const incident = mockIncidents[0]!;

    renderIncidentDetails(incident.id);

    expect(
      getMetricCard('Occurrences').getByText(
        String(incident.occurrences)
      )
    ).toBeTruthy();
  });

  it('displays the incident source', () => {
    const incident = mockIncidents[0]!;

    renderIncidentDetails(incident.id);

    expect(
      getMetricCard('Source').getByText(incident.source)
    ).toBeTruthy();
  });

  it('displays the last updated timestamp', () => {
    const incident = mockIncidents[0]!;

    renderIncidentDetails(incident.id);

    expect(
      getMetricCard('Last Updated').getByText(
        new Date(incident.updatedAt).toLocaleString()
      )
    ).toBeTruthy();
  });

  it('displays the error stack trace', () => {
    const incident = mockIncidents[0]!;

    renderIncidentDetails(incident.id);

    expect(screen.getByText('Error Stack Trace')).toBeTruthy();

    const code = document.querySelector('pre code');

    expect(code).not.toBeNull();
    expect(code?.textContent).toBe(incident.stackTrace);
  });

  it('displays the investigation timeline', () => {
    const incident = mockIncidents[0]!;

    renderIncidentDetails(incident.id);

    expect(
      screen.getByText('Investigation Timeline')
    ).toBeTruthy();

    expect(
      screen.getByText('Incident detected')
    ).toBeTruthy();

    expect(
      screen.getByText('Current status')
    ).toBeTruthy();

    expect(
      screen.getByText(`Error detected through ${incident.source}`)
    ).toBeTruthy();
  });

  it('shows the assigned agent and workspace link', () => {
    const incident = mockIncidents.find(
      (item) => item.assignedAgent !== null
    );

    expect(incident).toBeDefined();

    renderIncidentDetails(incident!.id);

    expect(
      getMetricCard('Assigned Agent').getByText(
        incident!.assignedAgent!
      )
    ).toBeTruthy();

    expect(screen.getByText('Agent assigned')).toBeTruthy();

    const workspaceLink = screen.getByRole('link', {
      name: 'View Agent Workspace',
    });

    expect(workspaceLink.getAttribute('href')).toBe(
      `/agents/${incident!.assignedAgent}`
    );
  });

  it('shows an unassigned message when no agent is assigned', () => {
    const incident = mockIncidents.find(
      (item) => !item.assignedAgent
    );

    expect(incident).toBeDefined();

    renderIncidentDetails(incident!.id);

    expect(
      getMetricCard('Assigned Agent').getByText('None')
    ).toBeTruthy();

    expect(
      screen.getByText(
        'No agent has been assigned to this incident.'
      )
    ).toBeTruthy();

    expect(
      screen.queryByRole('link', {
        name: 'View Agent Workspace',
      })
    ).toBeNull();
  });

  it('renders a back link to the incidents page', () => {
    const incident = mockIncidents[0]!;

    renderIncidentDetails(incident.id);

    const backLink = screen.getByRole('link', {
      name: 'Back to Incidents',
    });

    expect(backLink.getAttribute('href')).toBe('/incidents');
  });

  it('handles an invalid incident ID', () => {
    renderIncidentDetails('INVALID-ID');

    expect(
      screen.getByRole('heading', {
        name: 'Incident not found',
      })
    ).toBeTruthy();

    expect(
      screen.getByText(
        'The requested incident does not exist.'
      )
    ).toBeTruthy();

    const backLink = screen.getByRole('link', {
      name: 'Back to Incidents',
    });

    expect(backLink.getAttribute('href')).toBe('/incidents');
  });
});
