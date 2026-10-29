import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { motion } from 'framer-motion';
import { loginSchema, registerSchema } from '@tradecore/shared';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/primitives';
import { Disclaimer } from '@/components/layout/AppShell';
import { api, ApiError } from '@/lib/api';
import type { User } from '@/lib/types';
import { useAuth } from '@/stores/auth';

type TokenResponse = { accessToken: string; user: User };

function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-h-full place-items-center bg-background p-4">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-8" />
          <span className="text-xl font-semibold tracking-tight">TradeCore</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mb-6 mt-1 text-sm text-muted">{subtitle}</p>
        <div className="rounded-xl border bg-panel p-5">{children}</div>
        <Disclaimer className="mt-4 text-center" />
      </motion.div>
    </div>
  );
}

function Field({
  id,
  label,
  error,
  ...rest
}: { id: string; label: string; error?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} aria-invalid={!!error} aria-describedby={error ? `${id}-err` : undefined} {...rest} />
      {error && (
        <p id={`${id}-err`} className="text-xs text-sell">
          {error}
        </p>
      )}
    </div>
  );
}

const DEMO = ['asha@tradecore.dev', 'rahul@tradecore.dev', 'admin@tradecore.dev'];

export function LoginPage() {
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/trade';
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const submit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      const r = await api<TokenResponse>('/auth/login', { method: 'POST', body: values });
      useAuth.getState().setSession(r.accessToken, r.user);
      navigate(from, { replace: true });
    } catch (e) {
      setServerError(e instanceof ApiError ? e.message : 'Could not reach the server');
    }
  });

  return (
    <AuthLayout title="Welcome back" subtitle="Practise with ₹1,00,000 of virtual money on real live prices.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          error={form.formState.errors.email?.message}
          {...form.register('email')}
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          error={form.formState.errors.password?.message}
          {...form.register('password')}
        />
        {serverError && (
          <p role="alert" className="rounded-md bg-sell-soft px-3 py-2 text-sm text-sell">
            {serverError}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <div className="mt-4 border-t pt-4">
        <p className="mb-2 text-xs text-muted">Try a demo account (password Demo@1234):</p>
        <div className="flex flex-wrap gap-1.5">
          {DEMO.map((e) => (
            <Button
              key={e}
              variant="subtle"
              size="sm"
              type="button"
              onClick={() => {
                form.setValue('email', e);
                form.setValue('password', 'Demo@1234');
                void submit();
              }}
            >
              {e.split('@')[0]}
            </Button>
          ))}
        </div>
      </div>
      <p className="mt-4 text-center text-sm text-muted">
        New here?{' '}
        <Link to="/register" className="text-accent hover:underline">
          Create an account
        </Link>
      </p>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const navigate = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof registerSchema>>({
    resolver: zodResolver(registerSchema),
    defaultValues: { email: '', password: '', displayName: '' },
  });
  const submit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      const r = await api<TokenResponse>('/auth/register', { method: 'POST', body: values });
      useAuth.getState().setSession(r.accessToken, r.user);
      navigate('/trade', { replace: true });
    } catch (e) {
      setServerError(e instanceof ApiError ? e.message : 'Could not reach the server');
    }
  });
  const errs = form.formState.errors;
  return (
    <AuthLayout title="Start practising" subtitle="You get ₹1,00,000 of virtual money. No real money, ever.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field
          id="displayName"
          label="Display name"
          autoComplete="nickname"
          error={errs.displayName?.message}
          {...form.register('displayName')}
        />
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          error={errs.email?.message}
          {...form.register('email')}
        />
        <Field
          id="password"
          label="Password (8+ chars, a letter and a digit)"
          type="password"
          autoComplete="new-password"
          error={errs.password?.message}
          {...form.register('password')}
        />
        {serverError && (
          <p role="alert" className="rounded-md bg-sell-soft px-3 py-2 text-sm text-sell">
            {serverError}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? 'Creating…' : 'Create account'}
        </Button>
      </form>
      <p className="mt-4 text-center text-sm text-muted">
        Already have an account?{' '}
        <Link to="/login" className="text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
