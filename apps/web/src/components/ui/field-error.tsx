export function FieldError({ message }: { message?: string | undefined }) {
  if (!message) return null;
  return <p className="text-sm text-red-600">{message}</p>;
}
