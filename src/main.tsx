import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './lib/pwa'; // łapie beforeinstallprompt zanim zamontuje się React
import './index.css';

// SW tylko w produkcji — w devie cache'owałby moduły Vite i psuł HMR.
// Bez SW z handlerem fetch Chrome w ogóle nie odpala beforeinstallprompt.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
