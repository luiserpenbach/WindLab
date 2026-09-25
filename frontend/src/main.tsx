import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AnalysisProvider, CatalogProvider } from './state/analysis';
import { ProjectProvider } from './state/projectStore';
import { UiProvider } from './state/uiStore';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UiProvider>
      <ProjectProvider>
        <CatalogProvider>
          <AnalysisProvider>
            <App />
          </AnalysisProvider>
        </CatalogProvider>
      </ProjectProvider>
    </UiProvider>
  </StrictMode>,
);
