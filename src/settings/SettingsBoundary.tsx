import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Turns a missing settings bootstrap into a readable message instead of a blank
 * panel.
 *
 * This deliberately does **not** fall back to defaults: a second copy of the
 * defaults in JS is exactly how the panel and the backend start disagreeing.
 * The realistic trigger is running the Vite dev server in a plain browser, where
 * no `initialization_script` ever runs.
 */
export class SettingsBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Placemill] settings bootstrap failed:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="bootstrap-error">
        <h1>PlaceMill</h1>
        <p>Settings bootstrap was not applied, so the panel cannot start.</p>
        <p>
          Run the app with <code>npm run tauri dev</code> — a plain Vite server has no
          Tauri webview, so Rust never injects the settings.
        </p>
        <pre>{error.message}</pre>
      </div>
    );
  }
}
