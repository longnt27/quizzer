import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import 'antd/dist/reset.css';
import { initializeServerSync } from './db/serverSync.ts';
import { ensureAppProfile } from './utils/appProfile.ts';

// Classify a profile as new or upgraded only after the first server merge. This
// prevents a fresh browser connected to an existing library from being sent
// through first-run onboarding before its records arrive.
void initializeServerSync().then(() => ensureAppProfile());

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>
)
