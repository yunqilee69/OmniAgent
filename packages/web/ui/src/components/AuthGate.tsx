import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { Button, FishLogo, Input } from '../../vendor/primitives/index.ts';
import { auth } from '../lib/auth.ts';
import { resetStore, store, useApp } from '../lib/store.ts';
import { translator, type Locale } from '../lib/i18n.ts';
import { App } from '../app.tsx';
import css from '../styles/auth.module.css';

export function AuthGate(): ReactNode {
  const state = useSyncExternalStore(auth.subscribe, auth.getSnapshot);
  const locale = useApp().locale;
  const t = translator(locale);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    let wasReady = false;
    const unsubscribe = auth.subscribe(() => {
      const snapshot = auth.getSnapshot();
      const ready = snapshot.phase === 'ready';
      if ((wasReady && !ready) || (!wasReady && ready && snapshot.enabled)) resetStore();
      wasReady = ready;
    });
    void auth.check();
    return unsubscribe;
  }, []);
  useEffect(() => { if (state.phase !== 'login' || state.error !== null) setPassword(''); }, [state.phase, state.phase === 'login' ? state.error : null]);

  if (state.phase === 'ready') return <App />;
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void auth.login(username, password);
  };
  return (
    <main className={css.page}>
      <header className={css.topbar}>
        <div className={css.brand}><FishLogo size={28} /><span>OmniAgent</span></div>
        <label className={css.language}>
          <span className={css.srOnly}>{t('Language')}</span>
          <select value={locale} onChange={(event) => { store.setLocale(event.target.value as Locale); }}>
            <option value="zh">中文</option><option value="en">English</option>
          </select>
        </label>
      </header>
      <section className={css.content} aria-labelledby="auth-title" aria-busy={state.phase === 'checking' || (state.phase === 'login' && state.busy)}>
        {state.phase === 'checking' ? (
          <div role="status"><h1 id="auth-title">{t('Checking authentication…')}</h1></div>
        ) : state.phase === 'error' ? (
          <div><h1 id="auth-title">{t('Unable to check authentication')}</h1><p>{t('Check your connection and try again.')}</p><Button variant="outline" onClick={() => { void auth.check(); }}>{t('Retry')}</Button></div>
        ) : (
          <>
            <div className={css.intro}>
              <h1 id="auth-title">{t('Sign in to OmniAgent')}</h1>
              <p>{state.expired ? t('Your session has expired. Sign in again to continue.') : t('Sign in to continue to your workspace.')}</p>
            </div>
            <form className={css.form} onSubmit={submit}>
              <label htmlFor="auth-username">{t('Username')}</label>
              <Input id="auth-username" name="username" autoComplete="username" autoFocus required value={username} onChange={(event) => { setUsername(event.target.value); }} disabled={state.busy} />
              <label htmlFor="auth-password">{t('Password')}</label>
              <Input id="auth-password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => { setPassword(event.target.value); }} disabled={state.busy} />
              {state.error !== null && <p className={css.error} role="alert">{t(state.error === 'credentials' ? 'Invalid username or password.' : 'Request failed. Please try again.')}</p>}
              <Button className={css.submit} type="submit" variant="primary" disabled={state.busy}>{t(state.busy ? 'Signing in…' : 'Sign in')}</Button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
