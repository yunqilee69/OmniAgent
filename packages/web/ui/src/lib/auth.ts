export type AuthState =
  | { phase: 'checking' }
  | { phase: 'error' }
  | { phase: 'login'; expired: boolean; busy: boolean; error: 'credentials' | 'network' | null }
  | { phase: 'ready'; enabled: boolean };

export class AuthController {
  private state: AuthState = { phase: 'checking' };
  private listeners = new Set<() => void>();
  private generation = 0;
  private locked = false;
  private requests = new AbortController();

  private lock(): void {
    this.locked = true;
    this.requests.abort();
    this.requests = new AbortController();
  }

  getSnapshot = (): AuthState => this.state;
  getGeneration = (): number => this.generation;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private setState(state: AuthState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  async check(): Promise<void> {
    const generation = ++this.generation;
    this.lock();
    this.setState({ phase: 'checking' });
    try {
      const response = await fetch('/api/auth/status', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('Status unavailable');
      const status: unknown = await response.json();
      if (typeof status !== 'object' || status === null || Array.isArray(status)
        || typeof (status as { enabled?: unknown }).enabled !== 'boolean'
        || typeof (status as { authenticated?: unknown }).authenticated !== 'boolean') throw new Error('Invalid status');
      if (generation !== this.generation) return;
      const { enabled, authenticated } = status as { enabled: boolean; authenticated: boolean };
      this.locked = enabled && !authenticated;
      this.setState(this.locked ? { phase: 'login', expired: false, busy: false, error: null } : { phase: 'ready', enabled });
    } catch {
      if (generation === this.generation) this.setState({ phase: 'error' });
    }
  }

  async login(username: string, password: string): Promise<void> {
    if (this.state.phase !== 'login' || this.state.busy) return;
    const generation = ++this.generation;
    const expired = this.state.expired;
    this.setState({ phase: 'login', expired, busy: true, error: null });
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (generation !== this.generation) return;
      if (!response.ok) {
        this.setState({ phase: 'login', expired, busy: false, error: response.status === 401 || response.status === 403 ? 'credentials' : 'network' });
        return;
      }
      await this.check();
    } catch {
      if (generation === this.generation) this.setState({ phase: 'login', expired, busy: false, error: 'network' });
    }
  }

  async logout(): Promise<void> {
    if (this.state.phase !== 'ready' || !this.state.enabled) return;
    ++this.generation;
    this.lock();
    this.setState({ phase: 'login', expired: false, busy: true, error: null });
    const generation = this.generation;
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) throw new Error('Logout failed');
      if (generation === this.generation) this.setState({ phase: 'login', expired: false, busy: false, error: null });
    } catch {
      if (generation === this.generation) this.setState({ phase: 'login', expired: false, busy: false, error: 'network' });
    }
  }

  async request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (this.locked) throw new Error('Authentication required.');
    const generation = this.generation;
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const response = await fetch(input, { ...init, signal: signal ? AbortSignal.any([signal, this.requests.signal]) : this.requests.signal });
    if (generation !== this.generation) throw new Error('Authentication state changed.');
    if (response.status === 401) {
      ++this.generation;
      this.lock();
      this.setState({ phase: 'login', expired: true, busy: false, error: null });
    }
    return response;
  }
}

export const auth = new AuthController();
export const authFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => auth.request(input, init);
