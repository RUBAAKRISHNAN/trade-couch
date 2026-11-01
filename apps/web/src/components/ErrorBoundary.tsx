import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Catches a crash inside one page so it doesn't blank the whole app (header and navigation keep working).
 * `resetKey` (the route) clears the error when the user navigates elsewhere.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; resetKey?: string },
  { error: Error | null }
> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Page crashed:', error, info.componentStack);
  }

  override componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="grid h-full place-items-center p-6 text-center">
        <div>
          <p className="font-medium">Something went wrong on this page.</p>
          <p className="mt-1 text-sm text-muted">{this.state.error.message}</p>
          <Button className="mt-3" variant="outline" onClick={() => location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    );
  }
}
