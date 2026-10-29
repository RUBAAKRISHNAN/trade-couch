import { Construction } from 'lucide-react';

export default function ComingSoon({ title }: { title: string }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div>
        <Construction className="mx-auto mb-3 size-8 text-muted" />
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-muted">Coming in the next phase.</p>
      </div>
    </div>
  );
}
