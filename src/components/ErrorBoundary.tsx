import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Nom de la zone protégée, affiché à l'utilisateur. */
  label: string;
  className?: string;
}

interface State {
  failed: boolean;
}

/** Empêche qu'une erreur d'affichage locale (carte, graphique…) ne blanchisse toute la page. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.label}]`, error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        className={
          "flex h-full min-h-32 flex-col items-center justify-center gap-3 rounded-3xl border border-rose-400/30 bg-rose-500/10 p-6 text-center text-sm text-rose-100 " +
          (this.props.className ?? "")
        }
      >
        <p>
          <span className="font-semibold">{this.props.label}</span> n'a pas pu s'afficher.
        </p>
        <button
          type="button"
          onClick={() => this.setState({ failed: false })}
          className="rounded-lg bg-rose-500/30 px-3 py-1.5 text-xs font-semibold transition hover:bg-rose-500/45"
        >
          Réessayer
        </button>
      </div>
    );
  }
}
