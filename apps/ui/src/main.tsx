import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App';
import { ThemeProvider } from '@page/design-system/components/theme-provider';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="system" storageKey="page-ai-theme">
      <App />
    </ThemeProvider>
  </StrictMode>,
);
