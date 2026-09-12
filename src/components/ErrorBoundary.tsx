import { Component, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null };

/** Awaria renderu = czytelny ekran z przyciskiem powrotu, nie biały blank. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error('[UI] render crash:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-100 p-6 text-center dark:bg-slate-950">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
            Ups, coś się zepsuło
          </h1>
          <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">
            {this.state.error.message || 'Nieoczekiwany błąd renderowania.'}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700"
            >
              Spróbuj ponownie
            </button>
            <button
              type="button"
              onClick={() => {
                this.setState({ error: null });
                location.href = '/';
              }}
              className="rounded-xl border border-slate-300 px-5 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-brand-400 dark:border-slate-700 dark:text-slate-200"
            >
              Strona główna
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
