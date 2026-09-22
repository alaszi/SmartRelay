'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { AuthCard } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api-client';
import { ApiError } from '@/lib/api-shared';

const resetSchema = z.object({ password: z.string().min(8, 'At least 8 characters') });
type ResetForm = z.infer<typeof resetSchema>;

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const token = useSearchParams().get('token');
  const router = useRouter();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetForm>({ resolver: zodResolver(resetSchema) });

  async function onSubmit(data: ResetForm) {
    if (!token) {
      toast.error('This reset link is missing its token.');
      return;
    }
    try {
      await apiFetch('/api/auth/reset', {
        method: 'POST',
        body: JSON.stringify({ ...data, token }),
      });
      toast.success('Password updated. Sign in with your new password.');
      router.push('/login');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not reset the password');
    }
  }

  return (
    <AuthCard
      title="Choose a new password"
      footer={
        <Link href="/login" className="font-medium text-accent-700 hover:underline">
          Back to sign in
        </Link>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => void handleSubmit(onSubmit)(e)}>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">New password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            {...register('password')}
          />
          <FieldError message={errors.password?.message} />
        </div>
        <Button type="submit" disabled={isSubmitting} className="mt-2">
          {isSubmitting ? 'Saving…' : 'Save new password'}
        </Button>
      </form>
    </AuthCard>
  );
}
